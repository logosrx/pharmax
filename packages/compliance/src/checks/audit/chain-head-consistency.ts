// Probe: the audit chain head agrees with the audit log.
//
// `audit_chain_state` caches the tip of each tenant's hash chain
// (latestHash, latestSeq) so the next append can link to it without
// rescanning history. Everything downstream trusts that cache: the
// append path, the nightly Merkle root, the quarterly evidence pack.
// If the head falls behind the log, appends keep succeeding and
// verification keeps passing — against the wrong tip. The tamper
// evidence quietly stops covering the newest entries, which is the
// exact window an attacker would want uncovered.
//
// This is a cheap consistency check, not a hash verification: it
// compares latestSeq against MAX(seq) rather than recomputing the
// chain. Full re-verification is the job of
// scripts/security/verify-audit-chain-all-orgs.ts, which is far too
// expensive for a scheduler tick. The two are complementary — this
// one catches a stalled or missing head within the hour.
//
// A tenant with no audit rows and no chain state is NOT_APPLICABLE,
// not PASS. A brand-new organization has nothing to be consistent
// about, and reporting it as a pass would inflate the coverage
// numbers with tenants that have never been exercised.

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";

export const auditChainHeadConsistencyCheck = defineCheck({
  code: "audit.chain.head_consistency",
  title: "Audit chain head matches the audit log tip",
  description:
    "For each active organization, audit_chain_state.latestSeq must equal the " +
    "highest audit_log.seq. Catches a stalled or missing chain head, which would " +
    "leave the newest audit entries outside the tamper-evident chain while both " +
    "appends and verification continue to appear healthy.",
  severity: "CRITICAL",
  cadence: "CONTINUOUS",
  intervalMinutes: 60,
  controlCodes: ["CC7.2-2"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      const [aggregate, chainState] = await Promise.all([
        ctx.prisma.auditLog.aggregate({
          where: { organizationId: org.id },
          _max: { seq: true },
          _count: { _all: true },
        }),
        ctx.prisma.auditChainState.findUnique({
          where: { organizationId: org.id },
          select: { latestSeq: true },
        }),
      ]);

      const logCount = aggregate._count._all;
      const maxSeq = aggregate._max.seq;

      if (logCount === 0 && chainState === null) {
        return {
          outcome: "NOT_APPLICABLE" as const,
          summary: `${org.slug}: no audit entries yet; nothing to reconcile.`,
          findings: [],
          details: { organizationSlug: org.slug, auditLogCount: 0, chainStatePresent: false },
        };
      }

      if (chainState === null) {
        return {
          outcome: "FAIL" as const,
          summary:
            `${org.slug}: ${logCount} audit entries exist but there is no chain ` + `head row.`,
          findings: [
            {
              subject: `organization:${org.slug}`,
              detail:
                `audit_log holds ${logCount} entries with no audit_chain_state row, ` +
                `so no append can link to a verified tip.`,
            },
          ],
          details: {
            organizationSlug: org.slug,
            auditLogCount: logCount,
            chainStatePresent: false,
            // BigInt is not JSON-serializable and would break the
            // canonical digest, so seq values cross into `details` as
            // decimal strings.
            maxAuditLogSeq: maxSeq === null ? null : maxSeq.toString(),
          },
        };
      }

      const headSeq = chainState.latestSeq;
      const tipSeq = maxSeq ?? 0n;
      const consistent = headSeq === tipSeq;

      return {
        outcome: consistent ? ("PASS" as const) : ("FAIL" as const),
        summary: consistent
          ? `${org.slug}: chain head and log tip agree at seq ${headSeq.toString()}.`
          : `${org.slug}: chain head is at seq ${headSeq.toString()} but the log tip ` +
            `is ${tipSeq.toString()}.`,
        findings: consistent
          ? []
          : [
              {
                subject: `organization:${org.slug}`,
                detail:
                  `audit_chain_state.latestSeq is ${headSeq.toString()} while ` +
                  `MAX(audit_log.seq) is ${tipSeq.toString()}. Entries beyond the head ` +
                  `are outside the tamper-evident chain.`,
              },
            ],
        details: {
          organizationSlug: org.slug,
          auditLogCount: logCount,
          chainStatePresent: true,
          chainHeadSeq: headSeq.toString(),
          auditLogTipSeq: tipSeq.toString(),
          seqGap: (tipSeq - headSeq).toString(),
        },
      };
    }),
});
