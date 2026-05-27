// Worker-process adapters for the @pharmax/security digest probes.
//
// Mirrors `scripts/security/security-digest-probes.ts` but lives in
// the worker so the production loop (`nightly-security-digest-loop.ts`)
// has zero dependency on `scripts/`. The two files intentionally stay
// in sync — when adding a new probe, update both. A future refactor
// could lift the shared adapters into @pharmax/security itself once
// the Prisma model dependencies stabilize.

import { verifyChain } from "@pharmax/audit";
import type { PrismaClient } from "@pharmax/database";
import {
  createPrismaAuditChainSource,
  type AccessReviewCalendarProbe,
  type AuditChainStatus,
  type AuditChainStatusProbe,
  type BreakGlassSessionProbe,
  type FailedLoginProbe,
  type OutboxStatusEntry,
  type OutboxStatusProbe,
  type SentryStatusProbe,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

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
}): WorkerDigestProbes {
  const { prisma } = options;
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
      // TODO(Phase 5 schema): swap to `prisma.breakGlassSession.findMany(...)`
      // once the migration in `packages/security/src/break-glass/SCHEMA.md`
      // lands. Returning empty today keeps the digest pipeline alive
      // without misreporting.
      async listOpenedInWindow() {
        return [];
      },
    },
    failedLogins: {
      // TODO(Clerk events): wire against the `clerk.session.failed.v1`
      // outbox handler once it lands. Returning empty today.
      async listSpikes() {
        return [];
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
