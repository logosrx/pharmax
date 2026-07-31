// Shared probe adapters that bridge `@pharmax/security`'s
// digest/verification ports to the live `@pharmax/database` Prisma
// client. Kept under `scripts/security/` (not under the package)
// because they are the "outside the package boundary" wiring layer
// — the package itself remains free of any Prisma model assumptions
// beyond the audit_log/audit_chain_state schema.

import { verifyChain } from "@pharmax/audit";
import { LoginOutcome, type PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import {
  createPrismaAuditChainSource,
  type AuditChainStatus,
  type AuditChainStatusProbe,
  type BreakGlassSessionEntry,
  type BreakGlassSessionProbe,
  type FailedLoginProbe,
  type FailedLoginSpikeEntry,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;

// KEEP IN SYNC with `apps/worker/src/security/digest-probes.ts` — the
// worker owns the production loop; this file is the CLI wiring for
// operator-driven runs.

/** Mirror of DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD in the worker probes. */
export const DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD = 10;

/** Mirror of UNATTRIBUTED_FAILED_LOGIN_ORG in the worker probes. */
export const UNATTRIBUTED_FAILED_LOGIN_ORG = "(unattributed)";

/** Mirror of FAILED_LOGIN_OUTCOMES in the worker probes. */
export const FAILED_LOGIN_OUTCOMES: ReadonlyArray<LoginOutcome> = Object.freeze([
  LoginOutcome.INVALID_CREDENTIALS,
  LoginOutcome.MFA_FAILED,
  LoginOutcome.LOCKED_OUT,
  LoginOutcome.RATE_LIMITED,
  LoginOutcome.USER_INACTIVE,
]);

/**
 * Build an `AuditChainStatusProbe` that walks every organization's
 * audit chain via `verifyChain` and reports the result. Failures are
 * surfaced as a `{ valid: false, reason }` row — exceptions are
 * caught and converted, NEVER thrown out of the probe (the digest
 * pipeline must keep going).
 */
export function verifyChainProbeFromPrisma(prisma: PrismaClient): AuditChainStatusProbe {
  return {
    async verifyAllOrgs(args: {
      readonly logger: Logger;
    }): Promise<ReadonlyArray<AuditChainStatus>> {
      const orgs = await withSystemContext("security:list-orgs-for-chain-verify", () =>
        prisma.organization.findMany({ select: { id: true } })
      );
      const out: AuditChainStatus[] = [];
      const source = createPrismaAuditChainSource(prisma);
      for (const org of orgs) {
        try {
          const result = await withSystemContext("security:verify-chain", () =>
            verifyChain(source, { organizationId: org.id })
          );
          out.push({
            organizationId: org.id,
            valid: true,
            verifiedRows: result.verifiedRows,
            lastSeq: result.lastSeq === null ? null : result.lastSeq.toString(),
          });
        } catch (cause) {
          const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
          const seq = extractSeqFromError(cause);
          args.logger.error("digest.chain.broken", {
            organizationId: org.id,
            reason,
            seq,
          });
          out.push({
            organizationId: org.id,
            valid: false,
            reason,
            seq,
          });
        }
      }
      return out;
    },
  };
}

/**
 * Build a `BreakGlassSessionProbe` over the `break_glass_session`
 * table (phase5_break_glass_session migration). One entry per session
 * OPENED in the window, with its action count.
 */
export function breakGlassProbeFromPrisma(prisma: PrismaClient): BreakGlassSessionProbe {
  return {
    async listOpenedInWindow(args): Promise<ReadonlyArray<BreakGlassSessionEntry>> {
      const rows = await withSystemContext("security:digest:list-break-glass-sessions", () =>
        prisma.breakGlassSession.findMany({
          where: { openedAt: { gte: args.windowStart, lt: args.windowEnd } },
          orderBy: { openedAt: "asc" },
          include: { _count: { select: { actions: true } } },
        })
      );
      return rows.map((row) => ({
        sessionId: row.id,
        requestedByUserId: row.requestedByUserId,
        approvedByUserId: row.approvedByUserId,
        ticketUrl: row.ticketUrl,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
        actionCount: row._count.actions,
      }));
    },
  };
}

/**
 * Build a `FailedLoginProbe` over the in-house identity engine's
 * `login_attempt` ledger (ADR-0030). Reports one entry per org whose
 * failed-attempt count in the window meets the threshold; attempts
 * that resolved to no tenant (unknown email — the strongest
 * brute-force signal) aggregate under UNATTRIBUTED_FAILED_LOGIN_ORG.
 */
export function failedLoginProbeFromPrisma(
  prisma: PrismaClient,
  options?: { readonly threshold?: number }
): FailedLoginProbe {
  const threshold = options?.threshold ?? DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD;
  return {
    async listSpikes(args): Promise<ReadonlyArray<FailedLoginSpikeEntry>> {
      const windowHours =
        (args.windowEnd.getTime() - args.windowStart.getTime()) / (60 * 60 * 1000);
      const rows = await withSystemContext("security:digest:failed-login-spikes", () =>
        prisma.loginAttempt.groupBy({
          by: ["organizationId"],
          where: {
            outcome: { in: [...FAILED_LOGIN_OUTCOMES] },
            createdAt: { gte: args.windowStart, lt: args.windowEnd },
          },
          _count: { _all: true },
        })
      );
      return rows
        .filter((row) => row._count._all >= threshold)
        .map((row) => ({
          organizationId: row.organizationId ?? UNATTRIBUTED_FAILED_LOGIN_ORG,
          windowHours,
          failedLoginCount: row._count._all,
          threshold,
        }))
        .sort((a, b) => a.organizationId.localeCompare(b.organizationId));
    },
  };
}

function extractSeqFromError(cause: unknown): string | null {
  if (cause === null || typeof cause !== "object") return null;
  const metadata = (cause as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return null;
  const seq = (metadata as { seq?: unknown }).seq;
  if (typeof seq === "string") return seq;
  if (typeof seq === "bigint") return seq.toString();
  if (typeof seq === "number") return seq.toString();
  return null;
}
