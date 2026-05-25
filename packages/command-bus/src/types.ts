// Command and handler-result types.
//
// Design contract:
//
//   - A `Command` is a SCHEMA + a `handle` function. It is the ONLY
//     unit that may mutate domain state.
//   - The handler does NOT write to `command_log`, `audit_log`, or
//     `event_outbox`. It RETURNS a declarative `HandlerResult`; the
//     bus writes those tables. This centralizes the "every critical
//     command writes audit + outbox" contract in one place.
//   - The handler MAY write to any domain table (within the tx), and
//     MAY (for order-targeted commands) update the locked order row
//     and increment `order.version`.
//
// PHI rule:
//   - The handler MUST NOT include PHI in `audit.metadata` or in
//     `outboxEvents[].payload`. Use the bus's `redactFields`
//     declaration on the Command to strip request fields before
//     they hit `command_log.requestPayload`. The same redaction
//     rule applies to `responsePayload`.

import type { Prisma, PrismaClient } from "@pharmax/database";
import type { clock, logger } from "@pharmax/platform-core";
import type { PermissionCode } from "@pharmax/rbac";
import type { TenancyContext } from "@pharmax/tenancy";
import type { ZodType } from "zod";

/** Prisma's interactive-transaction client (`tx` inside `$transaction`). */
export type PrismaTxClient = Prisma.TransactionClient;

/** The full Prisma client (singleton from `@pharmax/database`). */
export type { PrismaClient };

export interface HandlerDeps<TInput> {
  readonly tx: PrismaTxClient;
  readonly ctx: TenancyContext;
  readonly input: TInput;
  /**
   * The `command_log.id` for this attempt. Handlers should attach
   * this to `audit.metadata.commandLogId` and to outbox event
   * payloads if they want downstream consumers to correlate back
   * to the command record.
   */
  readonly commandLogId: string;
  readonly correlationId: string;
  readonly clock: clock.Clock;
  readonly logger: logger.Logger;
}

export interface AuditEntryDraft {
  /** Stable action verb. Example: `"organization.created"`. */
  readonly action: string;
  /** Aggregate type. Example: `"Organization"`, `"User"`, `"Order"`. */
  readonly resourceType: string;
  /** Aggregate id. Optional (e.g. for `"login.failed"` events). */
  readonly resourceId?: string;
  /** Tenant scope snapshot. The bus fills this from ctx if omitted. */
  readonly scope?: Record<string, unknown>;
  /** PHI-redacted contextual metadata. */
  readonly metadata?: Record<string, unknown>;
}

export interface OutboxEventDraft {
  /** Stable, versioned event type. Example: `"organization.created.v1"`. */
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** PHI-redacted payload. Downstream consumers depend on this shape. */
  readonly payload: Record<string, unknown>;
}

export interface HandlerResult<TOutput> {
  readonly output: TOutput;
  readonly audit: AuditEntryDraft;
  readonly outboxEvents: ReadonlyArray<OutboxEventDraft>;
  /**
   * Set only for order-targeted commands. The bus carries this into
   * `command_log.targetOrderId` for the per-order command index.
   */
  readonly targetOrderId?: string;
}

/**
 * Tenant-scoped command. Runs inside an active user tenancy context
 * and is gated by RBAC.
 */
export interface Command<TInput, TOutput> {
  /** Unique command name. Goes into `command_log.commandName`. */
  readonly name: string;
  readonly inputSchema: ZodType<TInput>;
  /**
   * Permission required to execute. `null` is reserved for
   * commands that intentionally have no RBAC gate (e.g. self-
   * service "AcceptInvite") — extremely rare; prefer a permission.
   */
  readonly permission: PermissionCode | null;
  /**
   * If true, the bus refuses to run unless the active tenancy
   * context carries a `workstationId`. Use for actions that must
   * be initiated from a paired physical workstation (label print,
   * PV1 scan, etc.).
   */
  readonly requiresWorkstation?: boolean;
  /**
   * Object-path strings to redact from `command_log.requestPayload`
   * and `responsePayload` before write. Phase 1: simple top-level
   * key allowlist. Phase 2: extends to dotted paths and Zod
   * `.brand("phi")` markers.
   */
  readonly redactFields?: ReadonlyArray<string>;

  handle(deps: HandlerDeps<TInput>): Promise<HandlerResult<TOutput>>;
}

/**
 * System / platform-level command. Runs inside `withSystemContext`,
 * skips RBAC, and is responsible for returning the resolved
 * `targetOrganizationId` so the bus can write `command_log`,
 * `audit_log`, and `event_outbox` rows under that org.
 */
export interface SystemCommand<TInput, TOutput> {
  readonly name: string;
  readonly inputSchema: ZodType<TInput>;
  readonly redactFields?: ReadonlyArray<string>;

  handle(
    deps: Omit<HandlerDeps<TInput>, "ctx"> & {
      readonly systemReason: string;
    }
  ): Promise<SystemHandlerResult<TOutput>>;
}

export interface SystemHandlerResult<TOutput> {
  readonly output: TOutput;
  readonly targetOrganizationId: string;
  readonly audit: AuditEntryDraft;
  readonly outboxEvents: ReadonlyArray<OutboxEventDraft>;
}

export interface ExecuteOptions {
  /**
   * Client-supplied idempotency key. Required for tenant commands;
   * if omitted, the bus generates a ULID (which makes the command
   * effectively non-idempotent — fine for read-like commands, not
   * fine for "ApprovePV1"). Documented per-command.
   */
  readonly idempotencyKey?: string;
}
