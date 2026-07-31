// Production `BreakGlassClient` backed by the Prisma models landed in
// the `phase5_break_glass_session` migration (`break_glass_session` +
// `break_glass_action`).
//
// Responsibilities:
//
//   - Persist the session lifecycle rows and the per-operation action
//     ledger. Both tables are platform-level (RLS-exempt, cross-tenant
//     by definition — see SCHEMA.md); writes still run inside a
//     `withSystemContext` frame so the tenancy layer records WHY a
//     cross-tenant touch happened.
//
//   - Implement `withSystemContextTx` per the port contract: start a
//     Prisma interactive transaction, apply the `pharmax.system_context`
//     GUCs via the canonical @pharmax/tenancy helper (bound parameters,
//     tx-local scope), then hand the tx to the caller's `fn`. The
//     session wrapper in `break-glass-session.ts` records the
//     `break_glass_action` row around `fn`.
//
// PHI invariant: `parameters` MUST arrive pre-redacted (the port
// documents that the caller owns redaction). This adapter additionally
// JSON-normalizes the value so only JSON-serializable data ever
// reaches the jsonb column — a `Map`, class instance, or function
// smuggled into `parameters` degrades to its JSON projection rather
// than throwing mid-audit-write.

import type { PrismaClient } from "@pharmax/database";
import { applySystemSessionGuc, withSystemContext } from "@pharmax/tenancy";

import type {
  BreakGlassActionRecord,
  BreakGlassClient,
  BreakGlassSessionRecord,
  PrismaSystemContextTx,
} from "./break-glass-session.js";

export class PrismaBreakGlassClient implements BreakGlassClient {
  private readonly prisma: PrismaClient;

  constructor(options: { readonly prisma: PrismaClient }) {
    this.prisma = options.prisma;
  }

  async insertSession(input: {
    readonly id: string;
    readonly reason: string;
    readonly requestedByUserId: string;
    readonly ticketUrl: string;
    readonly approvedByUserId: string | null;
    readonly maxDurationMinutes: number;
    readonly openedAt: Date;
  }): Promise<BreakGlassSessionRecord> {
    const row = await withSystemContext("security:break-glass:open-session", () =>
      this.prisma.breakGlassSession.create({
        data: {
          id: input.id,
          reason: input.reason,
          requestedByUserId: input.requestedByUserId,
          ticketUrl: input.ticketUrl,
          approvedByUserId: input.approvedByUserId,
          maxDurationMinutes: input.maxDurationMinutes,
          openedAt: input.openedAt,
        },
      })
    );
    return mapSessionRow(row);
  }

  async closeSession(input: {
    readonly id: string;
    readonly closedAt: Date;
    readonly resolution: string;
  }): Promise<BreakGlassSessionRecord> {
    const row = await withSystemContext("security:break-glass:close-session", () =>
      this.prisma.breakGlassSession.update({
        where: { id: input.id },
        data: { closedAt: input.closedAt, resolution: input.resolution },
      })
    );
    return mapSessionRow(row);
  }

  async recordAction(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly actionLabel: string;
    readonly parameters: unknown;
    readonly success: boolean;
    readonly errorMessage: string | null;
    readonly commandLogId: string | null;
    readonly startedAt: Date;
    readonly completedAt: Date;
  }): Promise<BreakGlassActionRecord> {
    const parameters = normalizeJsonParameters(input.parameters);
    const row = await withSystemContext("security:break-glass:record-action", () =>
      this.prisma.breakGlassAction.create({
        data: {
          id: input.id,
          sessionId: input.sessionId,
          actionLabel: input.actionLabel,
          // Omitted (SQL NULL) when the caller supplied nothing —
          // Prisma's nullable-Json input rejects a bare `null`.
          ...(parameters !== undefined ? { parameters } : {}),
          success: input.success,
          errorMessage: input.errorMessage,
          commandLogId: input.commandLogId,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
        },
      })
    );
    return {
      id: row.id,
      sessionId: row.sessionId,
      actionLabel: row.actionLabel,
      parameters: row.parameters ?? null,
      success: row.success,
      errorMessage: row.errorMessage,
      commandLogId: row.commandLogId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  async withSystemContextTx<T>(
    args: { readonly reason: string },
    fn: (tx: PrismaSystemContextTx) => Promise<T>
  ): Promise<T> {
    return withSystemContext(args.reason, () =>
      this.prisma.$transaction(async (tx) => {
        await applySystemSessionGuc(tx, args.reason);
        return fn(tx);
      })
    );
  }
}

function mapSessionRow(row: {
  readonly id: string;
  readonly reason: string;
  readonly requestedByUserId: string;
  readonly ticketUrl: string;
  readonly approvedByUserId: string | null;
  readonly openedAt: Date;
  readonly maxDurationMinutes: number;
  readonly closedAt: Date | null;
  readonly resolution: string | null;
}): BreakGlassSessionRecord {
  return {
    id: row.id,
    reason: row.reason,
    requestedByUserId: row.requestedByUserId,
    ticketUrl: row.ticketUrl,
    approvedByUserId: row.approvedByUserId,
    openedAt: row.openedAt,
    maxDurationMinutes: row.maxDurationMinutes,
    closedAt: row.closedAt,
    resolution: row.resolution,
  };
}

type JsonInput =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonInput>
  | { readonly [key: string]: JsonInput };

/**
 * Project an arbitrary (already PHI-redacted) value onto its JSON
 * shape. Returns `undefined` for `null`/`undefined` so the caller can
 * omit the column entirely (SQL NULL) instead of fighting Prisma's
 * JsonNull sentinel types.
 */
function normalizeJsonParameters(value: unknown): Exclude<JsonInput, null> | undefined {
  if (value === null || value === undefined) return undefined;
  // A non-null input can still round-trip to null (JSON.stringify(NaN)
  // is "null"); collapse that to undefined too so the column is
  // omitted (SQL NULL) rather than tripping Prisma's JsonNull sentinel.
  const parsed = JSON.parse(JSON.stringify(value)) as JsonInput;
  return parsed === null ? undefined : (parsed as Exclude<JsonInput, null>);
}
