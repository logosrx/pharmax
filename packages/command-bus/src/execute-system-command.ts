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
//   3. No idempotency cache by default. CreateOrganization,
//      Migrate, etc. are usually invoked once and a duplicate
//      attempt should be visible as a separate command_log entry,
//      not silently replayed.
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

import { applySystemSessionGuc, tenancy, type SessionGucExecutor } from "@pharmax/tenancy";
import { CommandStatus, OutboxStatus } from "@pharmax/database";

import { getCommandBusConfiguration } from "./configure.js";
import { commandInputInvalidError, commandSystemContextRequiredError } from "./errors.js";
import { redactPayload } from "./redact.js";
import type { SystemCommand } from "./types.js";
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
    // Step 19 (failure) — for system commands command_log was
    // never written (we didn't know the org), so all we can do is
    // structured-log the failure here. The error surfaces to the
    // caller (a script / shell) which records it via its own audit.
    log.error("system command failed before commit", { err: describeError(err) });
    throw err;
  }

  // Step 19 (success) — mark command_log SUCCEEDED.
  const responsePayload = redactPayload(txResult.result.output, command.redactFields);
  await updateCommandLogStatus(config.prisma, {
    id: commandLogId,
    status: CommandStatus.SUCCEEDED,
    responsePayload,
    completedAt: config.clock.now(),
  });

  return txResult.result.output;
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
