// executeSystemCommand — platform-level / bootstrap orchestrator.
//
// Differences from the tenant executor:
//
//   1. No active user tenancy context. Must be invoked inside
//      `withSystemContext(reason, fn)`. The reason string is
//      carried into `audit_log.metadata.systemContextReason` so
//      reviewers see "who/what" triggered the bootstrap.
//   2. No RBAC. System commands are run by ops with shell access
//      and are gated by infrastructure access controls (sudo on
//      a bastion, IAM role on a Lambda, etc.). The audit trail
//      records WHAT happened; the access trail (CloudTrail, OS
//      logs) records WHO triggered it.
//   3. No `idempotency_key` cache row, and no PRE-flight lookup: the
//      target org id isn't known until the handler resolves it, so
//      there is nothing to scope a lookup by before the handler runs.
//      Idempotency rides on `command_log`'s
//      `(organizationId, commandName, idempotencyKey)` unique index
//      instead, resolved AFTER the fact — see
//      `replayPriorSystemAttempt`. A key whose prior attempt
//      SUCCEEDED returns that attempt's recorded (redacted) output,
//      the same value the tenant executor replays from its
//      idempotency row, rather than a raw Prisma P2002.
//
//      Two consequences worth knowing before you rely on this:
//        - The handler for the replayed attempt DOES run; it is the
//          rollback of its transaction that makes the replay safe.
//          Handlers must therefore stay side-effect-free outside
//          `tx`, which the bus contract already requires.
//        - `options.idempotencyKey` defaults to a fresh ULID, which
//          can never collide, so CreateOrganization / Migrate and
//          every other caller that omits it keeps exactly the
//          fire-once behavior it had: a duplicate attempt is a
//          separate command_log entry, never a replay. Only a caller
//          that passes an explicit key opts into replay — which also
//          means no system command returning one-time secret
//          material can be served from a replay unless its caller
//          asks for it (cf. ADR-0032).
//   4. The handler returns `targetOrganizationId` because the org
//      may not exist before the handler runs (CreateOrganization)
//      OR because the handler operates on multiple orgs (mass
//      data backfill, etc.). The bus uses that org id for
//      command_log/audit_log/event_outbox scope.
//   5. `command_log` is written INSIDE the tx because the org id
//      isn't available until after the handler resolves it. This
//      loses pre-tx crash visibility — acceptable for ops-driven
//      bootstrap commands run interactively.

import { randomUUID } from "node:crypto";

import { ulid } from "ulid";
import type { ZodError } from "zod";

import type { logger as loggerContract } from "@pharmax/platform-core";
import { applySystemSessionGuc, tenancy, type SessionGucExecutor } from "@pharmax/tenancy";
import { CommandStatus, OutboxStatus } from "@pharmax/database";

import { getCommandBusConfiguration, type CommandBusConfiguration } from "./configure.js";
import { classifyCommandLogConflict, isUniqueViolation } from "./conflict-recovery.js";
import {
  commandAlreadyExecutedError,
  commandInputInvalidError,
  commandSystemContextRequiredError,
} from "./errors.js";
import { redactPayload } from "./redact.js";
import type { PrismaTxClient, SystemCommand } from "./types.js";
import {
  createAuditLogInTx,
  createCommandLog,
  createOutboxEventsInTx,
  updateCommandLogStatus,
} from "./writers.js";

export interface ExecuteSystemOptions {
  /**
   * Override the idempotency key (rare). Defaults to a fresh ULID.
   * Use only when you genuinely want replay semantics for a
   * system command (e.g. a script that may be re-run after a
   * partial network failure).
   */
  readonly idempotencyKey?: string;
}

export async function executeSystemCommand<TInput, TOutput>(
  command: SystemCommand<TInput, TOutput>,
  rawInput: unknown,
  options: ExecuteSystemOptions = {}
): Promise<TOutput> {
  const config = getCommandBusConfiguration();
  const log = config.logger.child({ component: "command-bus", command: command.name });

  if (!tenancy.isSystemContext()) {
    throw commandSystemContextRequiredError({ commandName: command.name });
  }
  const systemReason = tenancy.getSystemContextReason() ?? "<unknown>";

  // Step 1 — Validate input.
  const parsed = command.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw commandInputInvalidError({
      commandName: command.name,
      issues: zodIssuesToFlat(parsed.error),
    });
  }
  const input = parsed.data;
  const redactedRequest = redactPayload(input, command.redactFields);

  // UUID, not ULID: `command_log.id` is `@db.Uuid`. correlationId +
  // idempotencyKey stay ULIDs (String columns; sortable is a feature).
  const commandLogId = randomUUID();
  const correlationId = ulid();
  const idempotencyKey = options.idempotencyKey ?? ulid();

  // Assigned inside the tx, read from the catch below. The org id is
  // only known once the handler has resolved it, and the transaction
  // that carried it is exactly the one that rolls back on a
  // command_log unique violation — so the recovery's scoped lookup
  // has to borrow it from here.
  let resolvedOrganizationId: string | undefined;

  let txResult;
  try {
    txResult = await config.prisma.$transaction(async (tx) => {
      // Step 8a — Set the RLS BYPASSRLS sentinel for the lifetime
      // of this tx. System commands need to write across orgs
      // (CreateOrganization runs before any tenant exists; data
      // migrations span tenants). The BYPASSRLS pharmax_system
      // role is selected via the `pharmax.system_context = 'on'`
      // GUC and reverts at tx end.
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, systemReason);

      // Steps 9-15 belong to the handler. The handler decides the
      // target org id and returns it; we cannot write command_log
      // until we know it.
      const result = await command.handle({
        tx,
        input,
        commandLogId,
        correlationId,
        clock: config.clock,
        logger: log,
        systemReason,
      });
      resolvedOrganizationId = result.targetOrganizationId;

      // Write command_log INSIDE the tx with the resolved org id.
      await createCommandLog(tx, {
        id: commandLogId,
        organizationId: result.targetOrganizationId,
        commandName: command.name,
        idempotencyKey,
        actorUserId: null,
        workstationId: null,
        requestPayload: redactedRequest,
        status: CommandStatus.RUNNING,
      });

      // Step 17 — Write audit_log.
      await createAuditLogInTx(tx, {
        organizationId: result.targetOrganizationId,
        actorUserId: null,
        audit: {
          ...result.audit,
          metadata: {
            ...(result.audit.metadata ?? {}),
            systemContextReason: systemReason,
          },
        },
        scope: { systemContext: true },
        commandLogId,
      });

      // Step 18 — Write event_outbox row(s).
      await createOutboxEventsInTx(tx, {
        organizationId: result.targetOrganizationId,
        events: result.outboxEvents,
        initialStatus: OutboxStatus.PENDING,
      });

      return { result, organizationId: result.targetOrganizationId };
    });
  } catch (err) {
    // An idempotency replay, not a failure: a prior attempt with this
    // key already reached command_log, so this attempt's mutation
    // rolled back on the unique index rather than applying twice.
    // Resolve it into the prior attempt's outcome.
    if (isUniqueViolation(err, "CommandLog") && resolvedOrganizationId !== undefined) {
      return await replayPriorSystemAttempt<TOutput>({
        config,
        log,
        systemReason,
        commandName: command.name,
        organizationId: resolvedOrganizationId,
        idempotencyKey,
      });
    }

    // Step 19 (failure) — for system commands command_log was
    // never written (we didn't know the org), so all we can do is
    // structured-log the failure here. The error surfaces to the
    // caller (a script / shell) which records it via its own audit.
    log.error("system command failed before commit", { err: describeError(err) });
    throw err;
  }

  // Step 19 (success) — mark command_log SUCCEEDED. command_log is
  // RLS-protected (ENABLE + FORCE), so this update must run inside
  // a transaction with the system-context GUC applied — a raw-client
  // update lands on an arbitrary pool connection with no GUC and is
  // denied under the restricted database roles.
  const responsePayload = redactPayload(txResult.result.output, command.redactFields);
  await runInSystemTx(config, systemReason, (tx) =>
    updateCommandLogStatus(tx, {
      id: commandLogId,
      status: CommandStatus.SUCCEEDED,
      responsePayload,
      completedAt: config.clock.now(),
    })
  );

  return txResult.result.output;
}

/**
 * Run `fn` inside a short transaction with the system-context RLS GUC
 * applied as the first statement. `command_log` is ENABLE + FORCE
 * row-level security, so every bus-side query against it needs the
 * GUC — a raw-client query lands on an arbitrary pool connection with
 * none and is denied under the restricted database roles.
 */
async function runInSystemTx<T>(
  config: CommandBusConfiguration,
  systemReason: string,
  fn: (tx: PrismaTxClient) => Promise<T>
): Promise<T> {
  return config.prisma.$transaction(async (tx) => {
    await applySystemSessionGuc(tx as unknown as SessionGucExecutor, systemReason);
    return fn(tx);
  });
}

/**
 * Resolve a `command_log` unique violation for a system command.
 *
 * Only reachable when the caller passed an explicit `idempotencyKey`
 * (the default fresh ULID cannot collide) AND a prior attempt with
 * that key already reached `command_log`. This attempt's handler ran
 * and its transaction rolled back with the violation, so nothing it
 * wrote survived — which is what makes returning the prior outcome
 * the correct answer rather than a convenient one.
 *
 *   SUCCEEDED → replay the prior attempt's recorded `responsePayload`.
 *               That column holds `redactPayload(output)`, the same
 *               value the tenant executor replays out of its
 *               `idempotency_key` row, so both executors hand back a
 *               redacted projection of the original output. A
 *               SUCCEEDED row with no payload means the outcome is
 *               unrecoverable → COMMAND_ALREADY_EXECUTED.
 *   FAILED    → COMMAND_ALREADY_EXECUTED. Deliberately NOT the
 *               tenant executor's "reuse the row and re-execute":
 *               this executor writes `command_log` inside the handler
 *               transaction, so a rolled-back attempt leaves no row
 *               at all and a FAILED row does not prove the mutation
 *               was undone. Re-executing under it would reuse the one
 *               row whose unique index is what prevents the double
 *               apply — on money commands, the wrong way to be wrong.
 *   RUNNING /
 *   PENDING   → COMMAND_IN_FLIGHT, thrown by the classifier.
 */
async function replayPriorSystemAttempt<TOutput>(input: {
  readonly config: CommandBusConfiguration;
  readonly log: loggerContract.Logger;
  readonly systemReason: string;
  readonly commandName: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
}): Promise<TOutput> {
  const conflict = await runInSystemTx(input.config, input.systemReason, (tx) =>
    classifyCommandLogConflict(tx, {
      organizationId: input.organizationId,
      commandName: input.commandName,
      idempotencyKey: input.idempotencyKey,
    })
  );

  switch (conflict.kind) {
    case "prior-succeeded": {
      if (conflict.prior.responsePayload === null) {
        throw commandAlreadyExecutedError({ commandName: input.commandName });
      }
      input.log.info("system command replay (command_log idempotency hit)", {
        idempotencyKey: input.idempotencyKey,
        organizationId: input.organizationId,
        priorCommandLogId: conflict.prior.id,
      });
      // The recorded response is a plain JSON value; the prior attempt
      // typed it as TOutput when it was written. We trust the record.
      return conflict.prior.responsePayload as TOutput;
    }
    case "prior-failed":
      throw commandAlreadyExecutedError({ commandName: input.commandName });
    default: {
      const _never: never = conflict;
      throw new Error(`unhandled command_log conflict: ${String(_never)}`);
    }
  }
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
  if (err instanceof Error) {
    return { code: err.name, message: err.message };
  }
  return { code: "UNCAUGHT", message: String(err) };
}
