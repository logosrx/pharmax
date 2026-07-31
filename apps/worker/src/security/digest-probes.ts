// Worker-process adapters for the @pharmax/security digest probes.
//
// Mirrors `scripts/security/security-digest-probes.ts` but lives in
// the worker so the production loop (`nightly-security-digest-loop.ts`)
// has zero dependency on `scripts/`. The two files intentionally stay
// in sync — when adding a new probe, update both. A future refactor
// could lift the shared adapters into @pharmax/security itself once
// the Prisma model dependencies stabilize.

import { verifyChain } from "@pharmax/audit";
import { LoginOutcome, type PrismaClient } from "@pharmax/database";
import {
  createPrismaAuditChainSource,
  type AccessReviewCalendarProbe,
  type AuditChainStatus,
  type AuditChainStatusProbe,
  type BreakGlassSessionEntry,
  type BreakGlassSessionProbe,
  type FailedLoginProbe,
  type FailedLoginSpikeEntry,
  type OutboxStatusEntry,
  type OutboxStatusProbe,
  type SentryStatusProbe,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

/**
 * Default per-org failed-login count (within the digest window) at or
 * above which the digest reports a spike. Deliberately low for a
 * B2B operator console: legitimate operators mistype a handful of
 * times; dozens of failures against one org in a day is either a
 * credential-stuffing run or an operator who needs a reset — both
 * belong in front of the security reviewer.
 */
export const DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD = 10;

/**
 * Sentinel `organizationId` for failed attempts that resolved to no
 * tenant (unknown email). These are the strongest brute-force signal
 * — an attacker enumerating emails never resolves an org — so they
 * are aggregated under this bucket rather than dropped.
 */
export const UNATTRIBUTED_FAILED_LOGIN_ORG = "(unattributed)";

/**
 * `login_attempt.outcome` values that count toward a spike. Everything
 * except SUCCESS and MFA_REQUIRED (the latter is a normal step-up
 * prompt on a correct password, not a failure signal).
 */
export const FAILED_LOGIN_OUTCOMES: ReadonlyArray<LoginOutcome> = Object.freeze([
  LoginOutcome.INVALID_CREDENTIALS,
  LoginOutcome.MFA_FAILED,
  LoginOutcome.LOCKED_OUT,
  LoginOutcome.RATE_LIMITED,
  LoginOutcome.USER_INACTIVE,
]);

export interface WorkerDigestProbes {
  readonly auditChain: AuditChainStatusProbe;
  readonly breakGlass: BreakGlassSessionProbe;
  readonly failedLogins: FailedLoginProbe;
  readonly outbox: OutboxStatusProbe;
  readonly sentry: SentryStatusProbe;
  readonly accessReviewCalendar: AccessReviewCalendarProbe;
}

export function createWorkerDigestProbes(options: {
  readonly prisma: PrismaClient;
  /** Override the failed-login spike threshold (tests / tuning). */
  readonly failedLoginSpikeThreshold?: number;
}): WorkerDigestProbes {
  const { prisma } = options;
  const failedLoginThreshold =
    options.failedLoginSpikeThreshold ?? DEFAULT_FAILED_LOGIN_SPIKE_THRESHOLD;
  const source = createPrismaAuditChainSource(prisma);

  return {
    auditChain: {
      async verifyAllOrgs({ logger }): Promise<ReadonlyArray<AuditChainStatus>> {
        const orgs = await withSystemContext("security:list-orgs-for-chain-verify", () =>
          prisma.organization.findMany({ select: { id: true } })
        );
        const out: AuditChainStatus[] = [];
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
            logger.error("digest.chain.broken", { organizationId: org.id, reason, seq });
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
    },
    breakGlass: {
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
    },
    failedLogins: {
      // Reads the in-house identity engine's `login_attempt` ledger
      // (ADR-0030) — the sign-in service records every failure in its
      // own committed tx, so the digest sees attempts even when the
      // command tx rolled back.
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
          .filter((row) => row._count._all >= failedLoginThreshold)
          .map((row) => ({
            organizationId: row.organizationId ?? UNATTRIBUTED_FAILED_LOGIN_ORG,
            windowHours,
            failedLoginCount: row._count._all,
            threshold: failedLoginThreshold,
          }))
          .sort((a, b) => a.organizationId.localeCompare(b.organizationId));
      },
    },
    outbox: {
      async listDeadCounts(args): Promise<ReadonlyArray<OutboxStatusEntry>> {
        const rows = await prisma.eventOutbox.groupBy({
          by: ["organizationId"],
          where: {
            status: "DEAD",
            createdAt: { gte: args.windowStart, lt: args.windowEnd },
          },
          _count: { _all: true },
        });
        return rows.map((row) => ({
          organizationId: row.organizationId,
          deadCount: row._count._all,
        }));
      },
    },
    sentry: {
      // TODO(Sentry API): wire against the Sentry Stats v2 API once the
      // org-token policy is finalized. The worker has SENTRY_DSN for
      // reporting OUT to Sentry; querying IN requires a separate auth
      // token + region.
      async fetchErrorVolume(args) {
        return {
          project: "pharmacy-os",
          errorCount: 0,
          windowHours: (args.windowEnd.getTime() - args.windowStart.getTime()) / (60 * 60 * 1000),
        };
      },
    },
    accessReviewCalendar: {
      // TODO(calendar): read `evidence/access-reviews/<period>/` mtimes
      // against the per-org schedule to project "due in N days". Returning
      // empty today.
      async listDueWithinDays() {
        return [];
      },
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
