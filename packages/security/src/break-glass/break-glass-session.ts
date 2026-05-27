// TODO(Phase 5 schema): the schema for `break_glass_session` and
// `break_glass_action` tables is described in SCHEMA.md in this folder.
// Until the migration lands, this module talks to a port
// (`BreakGlassClient`) rather than the Prisma client directly so it is
// fully testable with a fake.
//
// Break-glass SESSION (this module) is distinct from break-glass GRANT
// (in `@pharmax/rbac/break-glass.ts`):
//
//   - A break-glass GRANT elevates ONE actor's privileges to perform
//     a specific action they normally couldn't.
//
//   - A break-glass SESSION opens a `pharmax_system` Postgres role
//     context for an engineer performing forensic / repair / triage
//     work that crosses tenants. Every database op inside the session
//     is recorded in `break_glass_action` and the whole envelope is
//     audited.
//
// Why this lives in @pharmax/security, not @pharmax/rbac:
//
//   RBAC's break-glass is a domain primitive (a kind of grant);
//   sessions are a security-operations primitive — they have no
//   meaning in the workflow runtime. Keeping them in @pharmax/security
//   ensures that domain code can't import the session API by accident.

import { errors, type clock as clockNs } from "@pharmax/platform-core";

type Clock = clockNs.Clock;

import {
  BREAK_GLASS_SESSION_REASON_REQUIRED,
  BREAK_GLASS_SESSION_TICKET_REQUIRED,
  breakGlassSessionAlreadyClosedError,
  breakGlassSessionExpiredError,
} from "./errors.js";

/** Hard cap on session duration. Compliance-driven, do not raise without security review. */
export const BREAK_GLASS_SESSION_MAX_DURATION_MINUTES = 240;

/** Default session duration when the caller does not specify one. */
export const BREAK_GLASS_SESSION_DEFAULT_DURATION_MINUTES = 60;

export interface BreakGlassSessionInput {
  readonly reason: string;
  readonly requestedByUserId: string;
  readonly ticketUrl: string;
  /** Optional second approver. NULL means "to be filled in by a follow-up update". */
  readonly approvedByUserId?: string;
  readonly maxDurationMinutes?: number;
}

export interface BreakGlassSessionRecord {
  readonly id: string;
  readonly reason: string;
  readonly requestedByUserId: string;
  readonly ticketUrl: string;
  readonly approvedByUserId: string | null;
  readonly openedAt: Date;
  readonly maxDurationMinutes: number;
  closedAt: Date | null;
  resolution: string | null;
}

export interface BreakGlassActionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly actionLabel: string;
  readonly parameters: unknown;
  readonly success: boolean;
  readonly errorMessage: string | null;
  readonly commandLogId: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

/**
 * Minimal Prisma-shaped tx client exposed to `runAs(fn)`. The session
 * wrapper applies the `pharmax.system_context = 'on'` GUC before
 * invoking `fn` so any query running through the tx is RLS-bypassed.
 */
export interface PrismaSystemContextTx {
  $executeRaw(template: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<number>;
  $queryRaw<T = unknown>(
    template: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Promise<T>;
}

/**
 * Persistence + transaction port. The production implementation will
 * wrap `@pharmax/database`'s Prisma client; tests inject an in-memory
 * fake.
 */
export interface BreakGlassClient {
  insertSession(input: {
    readonly id: string;
    readonly reason: string;
    readonly requestedByUserId: string;
    readonly ticketUrl: string;
    readonly approvedByUserId: string | null;
    readonly maxDurationMinutes: number;
    readonly openedAt: Date;
  }): Promise<BreakGlassSessionRecord>;

  closeSession(input: {
    readonly id: string;
    readonly closedAt: Date;
    readonly resolution: string;
  }): Promise<BreakGlassSessionRecord>;

  recordAction(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly actionLabel: string;
    readonly parameters: unknown;
    readonly success: boolean;
    readonly errorMessage: string | null;
    readonly commandLogId: string | null;
    readonly startedAt: Date;
    readonly completedAt: Date;
  }): Promise<BreakGlassActionRecord>;

  /**
   * Run `fn` inside a Prisma transaction that has
   * `pharmax.system_context = 'on'` applied locally. Implementations
   * must:
   *   1. Start a tx.
   *   2. Run `SELECT set_config('pharmax.system_context', 'on', true)`.
   *   3. Run `SELECT set_config('pharmax.system_context_reason', <reason>, true)`.
   *   4. Invoke `fn(tx)`.
   * The wrapper here adds the audit recording around `fn`.
   */
  withSystemContextTx<T>(
    args: { readonly reason: string },
    fn: (tx: PrismaSystemContextTx) => Promise<T>
  ): Promise<T>;
}

export interface BreakGlassSessionHandle {
  readonly session: BreakGlassSessionRecord;
  /**
   * Execute `fn` under a `pharmax_system` Postgres context, record a
   * `break_glass_action` row with the outcome, and return the result
   * (or rethrow the error).
   */
  runAs<T>(
    args: {
      readonly actionLabel: string;
      /** PHI-redacted parameters. The caller is responsible for redaction. */
      readonly parameters?: unknown;
      /** Optional: if the action dispatched a command, the resulting `command_log.id`. */
      readonly commandLogId?: string | null;
    },
    fn: (tx: PrismaSystemContextTx) => Promise<T>
  ): Promise<T>;
}

interface ActiveSession {
  record: BreakGlassSessionRecord;
  closed: boolean;
}

/**
 * Open a break-glass session and return a handle whose `runAs` method
 * wraps each operation in a `pharmax_system` Postgres context and
 * records a `break_glass_action` row.
 *
 * The handle MUST be closed via `closeBreakGlassSession` — leaving it
 * open does not extend the session past `maxDurationMinutes`; the
 * `runAs` calls themselves refuse to execute once the session has
 * expired.
 */
export async function openBreakGlassSession(input: {
  readonly client: BreakGlassClient;
  readonly idFactory: () => string;
  readonly actionIdFactory: () => string;
  readonly clock: Clock;
  readonly session: BreakGlassSessionInput;
}): Promise<BreakGlassSessionHandle> {
  validateOpenInput(input.session);

  const maxDurationMinutes =
    input.session.maxDurationMinutes ?? BREAK_GLASS_SESSION_DEFAULT_DURATION_MINUTES;
  if (
    !Number.isFinite(maxDurationMinutes) ||
    maxDurationMinutes <= 0 ||
    maxDurationMinutes > BREAK_GLASS_SESSION_MAX_DURATION_MINUTES
  ) {
    throw new errors.ValidationError({
      code: "BREAK_GLASS_SESSION_DURATION_INVALID",
      message: `Break-glass session duration ${String(
        maxDurationMinutes
      )} must be > 0 and ≤ ${BREAK_GLASS_SESSION_MAX_DURATION_MINUTES} minutes.`,
      issues: [
        {
          path: ["maxDurationMinutes"],
          message: `must be in (0, ${BREAK_GLASS_SESSION_MAX_DURATION_MINUTES}]`,
        },
      ],
    });
  }

  const openedAt = input.clock.now();
  const record = await input.client.insertSession({
    id: input.idFactory(),
    reason: input.session.reason,
    requestedByUserId: input.session.requestedByUserId,
    ticketUrl: input.session.ticketUrl,
    approvedByUserId: input.session.approvedByUserId ?? null,
    maxDurationMinutes,
    openedAt,
  });

  const active: ActiveSession = { record, closed: false };

  const handle: BreakGlassSessionHandle = {
    get session(): BreakGlassSessionRecord {
      return active.record;
    },
    async runAs<T>(
      args: {
        readonly actionLabel: string;
        readonly parameters?: unknown;
        readonly commandLogId?: string | null;
      },
      fn: (tx: PrismaSystemContextTx) => Promise<T>
    ): Promise<T> {
      assertOpen(active);
      assertNotExpired(active.record, input.clock);

      const startedAt = input.clock.now();
      let success = false;
      let errorMessage: string | null = null;
      let outcome: T;
      try {
        outcome = await input.client.withSystemContextTx(
          { reason: `break-glass:${active.record.id}` },
          fn
        );
        success = true;
      } catch (cause) {
        errorMessage = describeError(cause);
        const completedAt = input.clock.now();
        await input.client.recordAction({
          id: input.actionIdFactory(),
          sessionId: active.record.id,
          actionLabel: args.actionLabel,
          parameters: args.parameters ?? null,
          success: false,
          errorMessage,
          commandLogId: args.commandLogId ?? null,
          startedAt,
          completedAt,
        });
        throw cause;
      }

      const completedAt = input.clock.now();
      await input.client.recordAction({
        id: input.actionIdFactory(),
        sessionId: active.record.id,
        actionLabel: args.actionLabel,
        parameters: args.parameters ?? null,
        success,
        errorMessage,
        commandLogId: args.commandLogId ?? null,
        startedAt,
        completedAt,
      });
      return outcome;
    },
  };

  return handle;
}

export async function closeBreakGlassSession(
  handle: BreakGlassSessionHandle,
  input: {
    readonly client: BreakGlassClient;
    readonly clock: Clock;
    readonly resolution: string;
  }
): Promise<BreakGlassSessionRecord> {
  if (typeof input.resolution !== "string" || input.resolution.trim().length === 0) {
    throw new errors.ValidationError({
      code: "BREAK_GLASS_SESSION_RESOLUTION_REQUIRED",
      message: "closeBreakGlassSession: resolution is required and must be a non-empty string.",
      issues: [{ path: ["resolution"], message: "must be a non-empty string" }],
    });
  }
  if (handle.session.closedAt !== null) {
    throw breakGlassSessionAlreadyClosedError({ sessionId: handle.session.id });
  }
  const closedAt = input.clock.now();
  const updated = await input.client.closeSession({
    id: handle.session.id,
    closedAt,
    resolution: input.resolution,
  });
  // Reflect the close into the handle's view (`session` is a getter).
  (handle.session as { closedAt: Date | null }).closedAt = updated.closedAt;
  (handle.session as { resolution: string | null }).resolution = updated.resolution;
  return updated;
}

function validateOpenInput(input: BreakGlassSessionInput): void {
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_SESSION_REASON_REQUIRED,
      message: "openBreakGlassSession: reason is required and must be a non-empty string.",
      issues: [{ path: ["reason"], message: "must be a non-empty string" }],
    });
  }
  if (typeof input.ticketUrl !== "string" || input.ticketUrl.trim().length === 0) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_SESSION_TICKET_REQUIRED,
      message: "openBreakGlassSession: ticketUrl is required (incident or change ticket URL).",
      issues: [{ path: ["ticketUrl"], message: "must be a non-empty string" }],
    });
  }
  if (typeof input.requestedByUserId !== "string" || input.requestedByUserId.length === 0) {
    throw new errors.ValidationError({
      code: "BREAK_GLASS_SESSION_REQUESTOR_REQUIRED",
      message: "openBreakGlassSession: requestedByUserId is required.",
      issues: [{ path: ["requestedByUserId"], message: "must be a non-empty string" }],
    });
  }
  if (input.approvedByUserId !== undefined && input.approvedByUserId === input.requestedByUserId) {
    throw new errors.ValidationError({
      code: "BREAK_GLASS_SESSION_SELF_APPROVAL_FORBIDDEN",
      message:
        "openBreakGlassSession: approvedByUserId must differ from requestedByUserId (four-eyes rule).",
      issues: [{ path: ["approvedByUserId"], message: "must differ from requestedByUserId" }],
    });
  }
}

function assertOpen(active: ActiveSession): void {
  if (active.closed || active.record.closedAt !== null) {
    throw breakGlassSessionAlreadyClosedError({ sessionId: active.record.id });
  }
}

function assertNotExpired(record: BreakGlassSessionRecord, clock: Clock): void {
  const expiresAt = new Date(record.openedAt.getTime() + record.maxDurationMinutes * 60_000);
  if (clock.now().getTime() >= expiresAt.getTime()) {
    throw breakGlassSessionExpiredError({
      sessionId: record.id,
      expiredAt: expiresAt,
    });
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return "Unknown error";
}
