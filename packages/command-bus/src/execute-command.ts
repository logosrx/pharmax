// executeCommand — the tenant-command orchestrator.
//
// This is the implementation of the 20-step contract from
// `.cursor/rules/01-workflow-safety.mdc`. Read it alongside that
// rule. Numbered comments map exactly to that document.
//
// What this guarantees:
//   1. Every successful command produces command_log, audit_log,
//      and event_outbox rows in the SAME database transaction as
//      the domain mutation. The bus refuses to commit unless all
//      three landed.
//   2. The idempotency cache prevents accidental double-execution;
//      same key + same payload returns the cached response WITHOUT
//      re-running the handler. Same key + different payload throws
//      ConflictError.
//   3. Validation, RBAC, and workstation checks happen BEFORE any
//      database write. A request that fails these gates has zero
//      database footprint.
//   4. Handler failures roll the entire tx back; the only side
//      effect is the pre-tx command_log row, which is updated to
//      status=FAILED with the error code. SOC 2 reviewers can
//      audit attempted-but-failed actions in command_log.
//
// What this DOES NOT do:
//   - Retry the handler. Retries are caller responsibility. A
//     handler failure marks command_log FAILED and the caller
//     must generate a NEW idempotency key to retry.
//   - Time-bound the handler. Long-running commands hold the tx
//     open; that's the handler's responsibility to keep short.
//   - Auto-write order_event rows. Order-targeted commands write
//     their own order_event (the bus doesn't know event types).

import { randomUUID } from "node:crypto";

import { ulid } from "ulid";
import type { ZodError } from "zod";

import { errors } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import {
  applyTenancySessionGuc,
  tenancy,
  type SessionGucExecutor,
  type TenancyContext,
} from "@pharmax/tenancy";
import { requirePermission } from "@pharmax/rbac";
import { CommandStatus, OutboxStatus } from "@pharmax/database";

import { getCommandBusConfiguration } from "./configure.js";
import { commandInputInvalidError, commandWorkstationRequiredError } from "./errors.js";
import { hashRequest } from "./hash.js";
import { lookupIdempotency, storeIdempotencyInTx } from "./idempotency.js";
import { redactPayload } from "./redact.js";
import type { Command, ExecuteOptions } from "./types.js";
import {
  createAuditLogInTx,
  createCommandLog,
  createOutboxEventsInTx,
  updateCommandLogStatus,
} from "./writers.js";

// ---- OTel meters ----------------------------------------------------------
//
// Instrument creation is module-scoped so the OTel meter is asked
// exactly once per process. When OTEL_ENABLED is false the global
// API returns a no-op meter, so `.add` / `.record` calls degrade
// silently — no caller-side gating needed.
//
// Label discipline (PHI guardrail): every metric below is labelled
// only by `command_name` and `outcome`. NO PHI, NO patient ids,
// NO order ids, NO tenant names. See observability/README.md for
// the master metric catalog.

const meter = getMeter("@pharmax/command-bus");

const commandDispatchedCounter = meter.createCounter("pharmax_command_dispatched_total", {
  description:
    "Commands dispatched through the bus. Outcome is one of success | fail | replay | sod_rejected.",
});

const commandDurationHistogram = meter.createHistogram("pharmax_command_duration_seconds", {
  description: "End-to-end command execution duration (validation through commit), in seconds.",
  unit: "s",
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
});

const commandIdempotencyDedupCounter = meter.createCounter(
  "pharmax_command_idempotency_dedup_total",
  { description: "Commands short-circuited by an idempotency cache hit (replay)." }
);

const commandSodRejectionCounter = meter.createCounter("pharmax_command_sod_rejection_total", {
  description: "Commands rejected at the separation-of-duties guard before any domain mutation.",
});

const SOD_VIOLATION_CODE = "SOD_VIOLATION";

export async function executeCommand<TInput, TOutput>(
  command: Command<TInput, TOutput>,
  rawInput: unknown,
  options: ExecuteOptions = {}
): Promise<TOutput> {
  const config = getCommandBusConfiguration();
  const log = config.logger.child({ component: "command-bus", command: command.name });
  const startHrTimeNs = process.hrtime.bigint();
  const labels = { command_name: command.name };

  // Step 1 — Validate request shape (Zod).
  const parsed = command.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw commandInputInvalidError({
      commandName: command.name,
      issues: zodIssuesToFlat(parsed.error),
    });
  }
  const input = parsed.data;
  const redactedRequest = redactPayload(input, command.redactFields);

  // Step 2 — Validate actor identity (tenancy context resolved).
  // Step 3 — Validate actor role (RBAC).
  // Step 4 — Validate organization scope (handled by tenancy extension).
  // Step 5 — Validate workstation if required.
  const ctx = tenancy.requireCurrentContext();
  if (command.permission !== null) {
    await requirePermission(command.permission);
  }
  if (command.requiresWorkstation === true && ctx.workstationId === undefined) {
    throw commandWorkstationRequiredError({ commandName: command.name });
  }

  // Step 6 — Check idempotency.
  const idempotencyKey = options.idempotencyKey ?? ulid();
  const requestHash = hashRequest(redactedRequest);
  const idempotency = await lookupIdempotency(config.prisma, {
    organizationId: ctx.organizationId,
    commandName: command.name,
    key: idempotencyKey,
    currentRequestHash: requestHash,
  });
  if (idempotency.kind === "replay") {
    log.info("command replay (idempotency hit)", {
      idempotencyKey,
      organizationId: ctx.organizationId,
    });
    commandIdempotencyDedupCounter.add(1, labels);
    commandDispatchedCounter.add(1, { ...labels, outcome: "replay" });
    commandDurationHistogram.record(elapsedSeconds(startHrTimeNs), {
      ...labels,
      outcome: "replay",
    });
    // The cached response is a plain JSON value; the call site
    // typed it as TOutput when it was written. We trust the cache.
    return (idempotency.responsePayload ?? undefined) as unknown as TOutput;
  }

  // Step 7 — Create command_log (PRE-TX so a crash leaves a record).
  // UUID, not ULID: `command_log.id` is `@db.Uuid`. The idempotency
  // key above stays a ULID (String column; sortable is a feature).
  const commandLogId = randomUUID();
  await createCommandLog(config.prisma, {
    id: commandLogId,
    organizationId: ctx.organizationId,
    commandName: command.name,
    idempotencyKey,
    actorUserId: ctx.actor.userId,
    workstationId: ctx.workstationId ?? null,
    requestPayload: redactedRequest,
    status: CommandStatus.RUNNING,
  });

  // Step 8 — Start tx, run handler, write audit + outbox, commit.
  let handlerResult;
  try {
    handlerResult = await config.prisma.$transaction(async (tx) => {
      // Step 8a — Set the Postgres session GUC for RLS BEFORE any
      // domain query runs. This is the database-layer enforcement
      // of `where organizationId = <tenant>`, complementing the
      // Prisma extension. Must be the FIRST statement inside the
      // tx so every subsequent query is subject to the policy.
      // The cast is safe: Prisma's tx client implements $executeRaw.
      await applyTenancySessionGuc(tx as unknown as SessionGucExecutor, ctx);

      // Steps 9-15 are the handler's responsibility (row locks,
      // workflow policy resolution, state validation, domain writes).
      const result = await command.handle({
        tx,
        ctx,
        input,
        commandLogId,
        correlationId: ctx.actor.correlationId,
        clock: config.clock,
        logger: log,
      });

      // Step 17 — Write audit_log inside the same tx.
      await createAuditLogInTx(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.actor.userId,
        audit: result.audit,
        scope: buildScopeSnapshot(ctx),
        commandLogId,
      });

      // Step 18 — Write event_outbox row(s) inside the same tx.
      await createOutboxEventsInTx(tx, {
        organizationId: ctx.organizationId,
        events: result.outboxEvents,
        initialStatus: OutboxStatus.PENDING,
      });

      // Store idempotency row in the SAME tx, so a tx rollback
      // also rolls back the cache write (no phantom replay rows).
      const responsePayload = redactPayload(result.output, command.redactFields);
      await storeIdempotencyInTx(tx, {
        organizationId: ctx.organizationId,
        commandName: command.name,
        key: idempotencyKey,
        requestHash,
        responsePayload,
        responseStatus: null,
      });

      return result;
    });
  } catch (err) {
    // Step 19 (failure path) — mark command_log FAILED and rethrow.
    const { code, message } = describeError(err);
    await updateCommandLogStatus(config.prisma, {
      id: commandLogId,
      status: CommandStatus.FAILED,
      errorCode: code,
      errorMessage: message,
      completedAt: config.clock.now(),
    });
    const outcome = code === SOD_VIOLATION_CODE ? "sod_rejected" : "fail";
    if (outcome === "sod_rejected") {
      commandSodRejectionCounter.add(1, labels);
    }
    commandDispatchedCounter.add(1, { ...labels, outcome });
    commandDurationHistogram.record(elapsedSeconds(startHrTimeNs), { ...labels, outcome });
    throw err;
  }

  // Step 19 (success path) — mark command_log SUCCEEDED.
  const responsePayload = redactPayload(handlerResult.output, command.redactFields);
  await updateCommandLogStatus(config.prisma, {
    id: commandLogId,
    status: CommandStatus.SUCCEEDED,
    responsePayload,
    completedAt: config.clock.now(),
  });

  commandDispatchedCounter.add(1, { ...labels, outcome: "success" });
  commandDurationHistogram.record(elapsedSeconds(startHrTimeNs), { ...labels, outcome: "success" });

  // Step 20 — Side effects fire from the drainer asynchronously.
  // Nothing to do here; the outbox row is already PENDING.
  return handlerResult.output;
}

/**
 * Convert an hrtime.bigint() start anchor to seconds (float) elapsed.
 * Used by the duration histogram. Nanosecond precision is preserved
 * by the bigint subtraction; the / 1e9 only happens at the JS level
 * for the final Number.
 */
function elapsedSeconds(startHrTimeNs: bigint): number {
  return Number(process.hrtime.bigint() - startHrTimeNs) / 1_000_000_000;
}

function buildScopeSnapshot(ctx: TenancyContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.siteId !== undefined) out["siteId"] = ctx.siteId;
  if (ctx.clinicId !== undefined) out["clinicId"] = ctx.clinicId;
  if (ctx.teamId !== undefined) out["teamId"] = ctx.teamId;
  if (ctx.bucketId !== undefined) out["bucketId"] = ctx.bucketId;
  if (ctx.workstationId !== undefined) out["workstationId"] = ctx.workstationId;
  return out;
}

function zodIssuesToFlat(
  error: ZodError
): ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> {
  return error.issues.map((i) => ({
    path: i.path as ReadonlyArray<string | number>,
    message: i.message,
  }));
}

function describeError(err: unknown): { code: string; message: string } {
  if (errors.isPharmaxError(err)) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "UNCAUGHT", message: err.message };
  }
  return { code: "UNCAUGHT", message: String(err) };
}
