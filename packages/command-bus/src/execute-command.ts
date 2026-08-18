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
//      ConflictError. Same key while a prior attempt is RUNNING
//      throws ConflictError(COMMAND_IN_FLIGHT). Same key after a
//      FAILED attempt re-executes (standard idempotency-key retry
//      semantics — the client may safely resend after an error).
//   3. Validation, RBAC, and workstation checks happen BEFORE any
//      database write. A request that fails these gates has zero
//      database footprint.
//   4. Handler failures roll the entire tx back; the only side
//      effect is the pre-tx command_log row, which is updated to
//      status=FAILED with the error code. SOC 2 reviewers can
//      audit attempted-but-failed actions in command_log.
//      The one deliberate exception is a COMMITTED REFUSAL (see
//      `HandlerResult.refusal`): the handler declines the act but
//      asks for its transaction to commit, because the evidence of
//      WHY it declined has to outlive the attempt. The tx commits,
//      command_log is still marked FAILED with the refusal's code,
//      no idempotency row is written, and the error is thrown to
//      the caller afterwards.
//
// RLS invariant (every statement, not just the handler tx):
//   command_log and idempotency_key are RLS-protected tables
//   (ENABLE + FORCE, policies keyed on the `pharmax.organization_id`
//   session GUC). The GUC is transaction-local, so ANY query the
//   bus issues against those tables must run inside a transaction
//   that applied the GUC first. That is why the pre-flight
//   (idempotency lookup + command_log create) and the post-run
//   status updates each run inside their own short GUC'd
//   transaction rather than on the raw pooled client — a raw-client
//   query lands on an arbitrary pool connection with NO tenant GUC
//   and is denied (or sees nothing) under the pharmax_app role.
//
// What this DOES NOT do:
//   - Time-bound the handler. Long-running commands hold the tx
//     open; that's the handler's responsibility to keep short.
//   - Auto-write order_event rows. Order-targeted commands write
//     their own order_event (the bus doesn't know event types).

import { randomUUID } from "node:crypto";

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
import { CommandStatus, OutboxStatus, type Prisma } from "@pharmax/database";

import { getCommandBusConfiguration, type CommandBusConfiguration } from "./configure.js";
import { classifyCommandLogConflict, isUniqueViolation } from "./conflict-recovery.js";
import {
  commandAlreadyExecutedError,
  commandInFlightError,
  commandInputInvalidError,
  commandWorkstationRequiredError,
} from "./errors.js";
import { FALLBACK_REQUEST_HASH_KEY, hashRequestKeyed } from "./hash.js";
import { lookupIdempotency, storeIdempotencyInTx, type LookupResult } from "./idempotency.js";
import { redactPayload } from "./redact.js";
import { transactionOptionsFor } from "./transaction-budget.js";
import type { Command, ExecuteCommandResult, ExecuteOptions, PrismaTxClient } from "./types.js";
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
    "Commands dispatched through the bus. Outcome is one of success | fail | refused | replay | sod_rejected.",
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

// See FALLBACK_REQUEST_HASH_KEY in hash.ts: publicly-known fallback
// for bare configurations (tests). Production boots through the
// composition root, which always supplies a KMS-derived
// `requestHashKey`; if a production process somehow reaches here
// without one we log a warning (once) rather than crash mid-request.
let warnedFallbackHashKey = false;

export async function executeCommand<TInput, TOutput>(
  command: Command<TInput, TOutput>,
  rawInput: unknown,
  options: ExecuteOptions
): Promise<TOutput> {
  const result = await executeCommandDetailed(command, rawInput, options);
  return result.output;
}

/**
 * Like `executeCommand`, but the result carries a `replayed` flag so
 * transport layers can distinguish "the handler ran now" from "this
 * is the idempotency cache". Required whenever the route generates
 * one-time secret material outside the command (ADR-0032): on a
 * replay that fresh secret was never stored and MUST NOT be
 * returned.
 */
export async function executeCommandDetailed<TInput, TOutput>(
  command: Command<TInput, TOutput>,
  rawInput: unknown,
  options: ExecuteOptions
): Promise<ExecuteCommandResult<TOutput>> {
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

  // The request hash covers the FULL parsed input (keyed HMAC), not
  // the redacted projection — see hash.ts for why. command_log and
  // idempotency_key still store only the REDACTED payload. The one
  // narrow exception: `hashExcludeFields` drops transport-generated
  // secret material (regenerated per HTTP attempt) so an honest
  // retry hashes identically and replays instead of 409ing.
  const idempotencyKey = options.idempotencyKey;
  const requestHash = hashRequestKeyed(
    omitHashExcludedFields(input, command.hashExcludeFields),
    resolveRequestHashKey(config, log)
  );

  const replayOutcome = (payload: unknown): TOutput => {
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
    return (payload ?? undefined) as TOutput;
  };

  // Steps 6 + 7 — Check idempotency, create command_log (PRE-TX so
  // a crash mid-handler leaves a RUNNING record). Both statements
  // run in ONE short GUC'd transaction (see the RLS invariant in
  // the header). A unique violation on command_log means another
  // attempt with this key exists; `recoverFromCommandLogConflict`
  // resolves it in a FRESH transaction because Postgres aborts the
  // current one on any statement error.
  let preflight: PreflightResult;
  try {
    preflight = await runInTenantTx(config, ctx, async (tx) => {
      const lookup = await lookupIdempotency(tx, {
        organizationId: ctx.organizationId,
        commandName: command.name,
        key: idempotencyKey,
        currentRequestHash: requestHash,
      });
      if (lookup.kind === "replay") {
        return { kind: "replay", responsePayload: lookup.responsePayload };
      }
      const commandLogId = randomUUID();
      await createCommandLog(tx, {
        id: commandLogId,
        organizationId: ctx.organizationId,
        commandName: command.name,
        idempotencyKey,
        actorUserId: ctx.actor.userId,
        workstationId: ctx.workstationId ?? null,
        requestPayload: redactedRequest,
        status: CommandStatus.RUNNING,
      });
      return { kind: "proceed", commandLogId };
    });
  } catch (err) {
    if (!isUniqueViolation(err, "CommandLog")) throw err;
    preflight = await recoverFromCommandLogConflict({
      config,
      ctx,
      commandName: command.name,
      idempotencyKey,
      requestHash,
      redactedRequest,
    });
  }
  if (preflight.kind === "replay") {
    return { output: replayOutcome(preflight.responsePayload), replayed: true };
  }
  const commandLogId = preflight.commandLogId;

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
      //
      // A committed refusal is deliberately NOT cached. The caller's
      // remedy for a refusal is to change the world and retry, and a
      // cached refusal would answer that retry with the very refusal
      // it was sent to resolve — for as long as the key survives.
      // The same-key retry re-executes instead, which is what the
      // FAILED command_log status below already promises.
      if (result.refusal === undefined) {
        const responsePayload = redactPayload(result.output, command.redactFields);
        await storeIdempotencyInTx(tx, {
          organizationId: ctx.organizationId,
          commandName: command.name,
          key: idempotencyKey,
          requestHash,
          responsePayload,
          responseStatus: null,
        });
      }

      return result;
    }, transactionOptionsFor(config.transactionBudget));
  } catch (err) {
    // Concurrent same-key race: two attempts both missed the
    // pre-flight lookup (e.g. two retries of a FAILED attempt);
    // the loser hits the idempotency_key unique constraint at
    // commit time. Resolve it as a replay instead of surfacing a
    // raw Prisma error. The winner owns the shared command_log
    // row's final status, so the loser does NOT mark it FAILED.
    if (isUniqueViolation(err, "IdempotencyKey")) {
      const lookup = await runInTenantTx(config, ctx, (tx) =>
        lookupIdempotency(tx, {
          organizationId: ctx.organizationId,
          commandName: command.name,
          key: idempotencyKey,
          currentRequestHash: requestHash,
        })
      );
      if (lookup.kind === "replay") {
        return { output: replayOutcome(lookup.responsePayload), replayed: true };
      }
      // Winner's tx not committed/visible yet — surface a stable 409.
      throw commandInFlightError({ commandName: command.name });
    }

    // Step 19 (failure path) — mark command_log FAILED and rethrow.
    // The status update is best-effort: if IT fails (e.g. the DB
    // just went away), we log and rethrow the ORIGINAL error so the
    // caller sees why the command failed, not why bookkeeping did.
    const { code, message } = describeError(err);
    try {
      await runInTenantTx(config, ctx, (tx) =>
        updateCommandLogStatus(tx, {
          id: commandLogId,
          status: CommandStatus.FAILED,
          errorCode: code,
          errorMessage: message,
          completedAt: config.clock.now(),
        })
      );
    } catch (updateErr) {
      log.error("failed to mark command_log FAILED", {
        commandLogId,
        err: describeError(updateErr),
      });
    }
    const outcome = code === SOD_VIOLATION_CODE ? "sod_rejected" : "fail";
    if (outcome === "sod_rejected") {
      commandSodRejectionCounter.add(1, labels);
    }
    commandDispatchedCounter.add(1, { ...labels, outcome });
    commandDurationHistogram.record(elapsedSeconds(startHrTimeNs), { ...labels, outcome });
    throw err;
  }

  // Step 19 (committed-refusal path) — the tx COMMITTED, so the
  // handler's evidence is durable, but the act was refused. Record
  // the same FAILED command_log row a rollback refusal would have
  // written (same status, same errorCode, so nothing downstream has
  // to learn a new shape) and rethrow, so the caller sees the refusal
  // as the typed error its class already promises.
  if (handlerResult.refusal !== undefined) {
    const refusal = handlerResult.refusal;
    try {
      await runInTenantTx(config, ctx, (tx) =>
        updateCommandLogStatus(tx, {
          id: commandLogId,
          status: CommandStatus.FAILED,
          errorCode: refusal.code,
          errorMessage: refusal.message,
          completedAt: config.clock.now(),
          ...(handlerResult.targetOrderId === undefined
            ? {}
            : { targetOrderId: handlerResult.targetOrderId }),
        })
      );
    } catch (updateErr) {
      log.error("failed to mark command_log FAILED after a committed refusal", {
        commandLogId,
        err: describeError(updateErr),
      });
    }
    commandDispatchedCounter.add(1, { ...labels, outcome: "refused" });
    commandDurationHistogram.record(elapsedSeconds(startHrTimeNs), {
      ...labels,
      outcome: "refused",
    });
    throw refusal;
  }

  // Step 19 (success path) — mark command_log SUCCEEDED (GUC'd tx;
  // see RLS invariant). Also stamp targetOrderId so per-order
  // command history queries return this attempt.
  const responsePayload = redactPayload(handlerResult.output, command.redactFields);
  await runInTenantTx(config, ctx, (tx) =>
    updateCommandLogStatus(tx, {
      id: commandLogId,
      status: CommandStatus.SUCCEEDED,
      responsePayload,
      completedAt: config.clock.now(),
      ...(handlerResult.targetOrderId === undefined
        ? {}
        : { targetOrderId: handlerResult.targetOrderId }),
    })
  );

  commandDispatchedCounter.add(1, { ...labels, outcome: "success" });
  commandDurationHistogram.record(elapsedSeconds(startHrTimeNs), { ...labels, outcome: "success" });

  // Step 20 — Side effects fire from the drainer asynchronously.
  // Nothing to do here; the outbox row is already PENDING.
  return { output: handlerResult.output, replayed: false };
}

/**
 * Drop `hashExcludeFields` (transport-generated secret material)
 * from the payload before it enters the idempotency request hash.
 * Only top-level keys, mirroring redactFields Phase 1 semantics.
 */
function omitHashExcludedFields(
  input: unknown,
  fields: ReadonlyArray<string> | undefined
): unknown {
  if (fields === undefined || fields.length === 0) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!fields.includes(k)) out[k] = v;
  }
  return out;
}

// ---- Pre-flight helpers ---------------------------------------------------

type PreflightResult =
  | { readonly kind: "replay"; readonly responsePayload: unknown }
  | { readonly kind: "proceed"; readonly commandLogId: string };

/**
 * Run `fn` inside a short transaction with the tenant RLS GUC
 * applied as the first statement. Every bus-side query against the
 * RLS-protected bookkeeping tables goes through here.
 */
async function runInTenantTx<T>(
  config: CommandBusConfiguration,
  ctx: TenancyContext,
  fn: (tx: PrismaTxClient) => Promise<T>
): Promise<T> {
  return config.prisma.$transaction(async (tx) => {
    await applyTenancySessionGuc(tx as unknown as SessionGucExecutor, ctx);
    return fn(tx);
  }, transactionOptionsFor(config.transactionBudget));
}

/**
 * A command_log unique violation means another attempt with the
 * same (organizationId, commandName, idempotencyKey) exists.
 * `classifyCommandLogConflict` (shared with the system executor)
 * reads the prior row and decides; this function applies the
 * TENANT-side action for each outcome:
 *
 *   FAILED             → reuse the row: flip it back to RUNNING and
 *                        re-execute (idempotency-key retry). Safe
 *                        here because command_log is written PRE-tx,
 *                        so a FAILED row provably belongs to an
 *                        attempt whose mutation rolled back.
 *   SUCCEEDED          → replay from the idempotency row (which
 *                        also enforces the payload-mismatch check);
 *                        if the idempotency row is gone (expired /
 *                        purged) surface COMMAND_ALREADY_EXECUTED.
 *   RUNNING / PENDING  → COMMAND_IN_FLIGHT (stable 409; the client
 *                        should retry shortly, not resubmit) —
 *                        thrown by the classifier.
 *
 * Runs in a FRESH transaction — the one that hit the violation is
 * aborted (Postgres refuses further statements after an error).
 */
async function recoverFromCommandLogConflict(input: {
  readonly config: CommandBusConfiguration;
  readonly ctx: TenancyContext;
  readonly commandName: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly redactedRequest: Record<string, unknown>;
}): Promise<PreflightResult> {
  return runInTenantTx(input.config, input.ctx, async (tx) => {
    const conflict = await classifyCommandLogConflict(tx, {
      organizationId: input.ctx.organizationId,
      commandName: input.commandName,
      idempotencyKey: input.idempotencyKey,
    });

    switch (conflict.kind) {
      case "prior-failed": {
        await tx.commandLog.update({
          where: { id: conflict.prior.id },
          data: {
            status: CommandStatus.RUNNING,
            errorCode: null,
            errorMessage: null,
            completedAt: null,
            requestPayload: input.redactedRequest as Prisma.InputJsonValue,
            startedAt: input.config.clock.now(),
          },
        });
        return { kind: "proceed", commandLogId: conflict.prior.id };
      }
      case "prior-succeeded": {
        // Throws COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH if the hash
        // differs — exactly the contract the pre-flight lookup applies.
        const lookup: LookupResult = await lookupIdempotency(tx, {
          organizationId: input.ctx.organizationId,
          commandName: input.commandName,
          key: input.idempotencyKey,
          currentRequestHash: input.requestHash,
        });
        if (lookup.kind === "replay") {
          return { kind: "replay", responsePayload: lookup.responsePayload };
        }
        throw commandAlreadyExecutedError({ commandName: input.commandName });
      }
      default: {
        const _never: never = conflict;
        throw new Error(`unhandled command_log conflict: ${String(_never)}`);
      }
    }
  });
}

function resolveRequestHashKey(
  config: CommandBusConfiguration,
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): string | Buffer {
  if (config.requestHashKey !== undefined) return config.requestHashKey;
  if (!warnedFallbackHashKey && process.env["NODE_ENV"] === "production") {
    warnedFallbackHashKey = true;
    log.warn(
      "command bus is using the fallback (publicly known) request-hash key in production; " +
        "wire requestHashKey via the composition root"
    );
  }
  return FALLBACK_REQUEST_HASH_KEY;
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
