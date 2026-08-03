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
import type { clock, errors, logger } from "@pharmax/platform-core";
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

interface HandlerResultCommon {
  readonly audit: AuditEntryDraft;
  readonly outboxEvents: ReadonlyArray<OutboxEventDraft>;
  /**
   * Set only for order-targeted commands. The bus carries this into
   * `command_log.targetOrderId` for the per-order command index.
   */
  readonly targetOrderId?: string;
}

/**
 * What a handler returns: EITHER an output the bus commits and hands
 * back, OR a refusal the bus commits and then throws. The two are
 * exclusive by construction — a refused act has no output to return,
 * and a handler that produced one would be describing something that
 * did not happen.
 *
 * A COMMITTED REFUSAL is a handler that ran, declined to perform the
 * act it was asked to perform, and wrote down why. The bus commits
 * the transaction — audit row, order_event rows, outbox rows and
 * whatever evidence the handler persisted all land — and then THROWS
 * the error to the caller, so the API contract of a refusal is
 * unchanged: error class still decides the HTTP status, exactly as it
 * does for a refusal that rolls back.
 *
 * Use it ONLY when the refusal's own evidence has to outlive the
 * attempt. The motivating case is `ApprovePV1`: its gate refuses on a
 * clinical-screening finding, and if the screen that produced that
 * finding rolls back with the refusal, the pharmacist is told "a
 * finding is outstanding" by a console that can no longer show them
 * any such finding — and there is then no way to acknowledge it and
 * no way forward. A refusal that destroys its own evidence is a
 * deadlock, not a safety control.
 *
 * The default remains a rollback. Throwing from the handler is still
 * right for a refusal whose evidence is the `command_log` row alone;
 * rows that describe an act which did not happen have to earn their
 * place.
 *
 * What the bus does differently on this path:
 *
 *   - NO IDEMPOTENCY ROW is written. A refusal must never be replayed
 *     from cache: the caller's remedy is to change the world (record
 *     the acknowledgement) and try again, and a cached refusal would
 *     answer that retry with the very refusal it was sent to resolve.
 *   - `command_log` is still marked FAILED with the refusal's code —
 *     the same row a rollback refusal wrote — so dashboards keyed on
 *     `errorCode` do not move.
 *   - The handler MUST NOT return `bumpVersion` alongside a refusal.
 *     A refusal performs no transition; the factory fails closed if
 *     both are set.
 */
export type HandlerResult<TOutput> =
  | (HandlerResultCommon & { readonly output: TOutput; readonly refusal?: undefined })
  | (HandlerResultCommon & { readonly output?: undefined; readonly refusal: errors.PharmaxError });

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
  /**
   * Top-level input fields EXCLUDED from the idempotency request
   * hash. Reserved for TRANSPORT-GENERATED secret material (token
   * hashes, signing secrets) that is regenerated fresh on every
   * HTTP attempt: hashing such a field makes an honest client
   * retry carry a different hash and get rejected with
   * COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH instead of replaying.
   *
   * NEVER list a client-controlled field here — that would let two
   * genuinely different requests share an idempotency key and the
   * second would silently replay the first one's response (the
   * exact failure mode the full-payload hash exists to prevent;
   * see hash.ts).
   */
  readonly hashExcludeFields?: ReadonlyArray<string>;

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

/**
 * Result of `executeCommandDetailed`. `replayed` is true when the
 * response was served from the idempotency cache WITHOUT running
 * the handler. Transport layers that generate one-time secret
 * material (API-key tokens, webhook signing secrets) must check
 * this flag: on a replay the freshly generated secret was NOT
 * stored, so it must not be returned to the caller.
 */
export interface ExecuteCommandResult<TOutput> {
  readonly output: TOutput;
  readonly replayed: boolean;
}

export interface ExecuteOptions {
  /**
   * Caller-supplied idempotency key. REQUIRED — the workflow-safety
   * rules mandate an idempotency key on every critical mutation
   * command, and a silently-generated key makes retries and
   * double-submits execute twice instead of replaying. Callers that
   * genuinely want fire-once semantics (seed scripts, one-shot
   * system-adjacent actions) must construct an explicit unique key
   * so the decision is visible at the call site.
   *
   * Retry semantics: same key + same payload replays the cached
   * response; same key + different payload is a 409
   * (COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH); same key while a prior
   * attempt is still executing is a 409 (COMMAND_IN_FLIGHT); same
   * key after a FAILED attempt re-executes the command.
   */
  readonly idempotencyKey: string;
}
