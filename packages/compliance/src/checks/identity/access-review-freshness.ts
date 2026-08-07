// Probe: each tenant has a current-period access review on file.
//
// SOC 2 CC6.2 wants periodic review of who has access. The platform
// already records the evidence (access_review_snapshot, ADR-0027);
// nothing until now has verified that the evidence keeps ARRIVING.
// A quarterly obligation that silently stops being met looks
// identical to one being met, right up until the auditor asks for
// the current quarter and finds the newest snapshot is from March.
//
// The threshold is deliberately longer than the 90-day quarter. A
// review generated on day 1 of Q3 is not stale on day 1 of Q4 —
// treating it as stale would fail the check for teams doing exactly
// the right thing on a slightly different calendar. 100 days leaves
// a ten-day grace and still fails long before a missed quarter can
// be mistaken for a met one.

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";

export const ACCESS_REVIEW_MAX_AGE_DAYS = 100;

export const accessReviewFreshnessCheck = defineCheck({
  code: "identity.access_review.period_freshness",
  title: "Access review on file for the current period",
  description:
    `For each active organization, the most recent access_review_snapshot must be ` +
    `no older than ${ACCESS_REVIEW_MAX_AGE_DAYS} days — a quarter plus a ten-day ` +
    `grace window. Fails when the newest snapshot is stale or when an organization ` +
    `has never had one generated.`,
  severity: "HIGH",
  cadence: "DAILY",
  intervalMinutes: 1440,
  controlCodes: ["CC6.2-2"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      const newest = await ctx.prisma.accessReviewSnapshot.findFirst({
        where: { organizationId: org.id },
        select: { id: true, generatedAt: true, periodEnd: true },
        orderBy: { generatedAt: "desc" },
      });

      if (newest === null) {
        return {
          outcome: "FAIL" as const,
          summary: `${org.slug}: no access review has ever been generated.`,
          findings: [
            {
              subject: `organization:${org.slug}`,
              detail:
                "No access_review_snapshot rows exist, so there is no evidence " +
                "of any periodic access review for this tenant.",
            },
          ],
          // Same key set as the branch below, with null where there is
          // no snapshot to describe. A details payload whose shape
          // shifts with the outcome cannot be compared run over run.
          details: {
            organizationSlug: org.slug,
            newestSnapshotId: null,
            newestGeneratedAt: null,
            newestPeriodEnd: null,
            ageDays: null,
            maxAgeDays: ACCESS_REVIEW_MAX_AGE_DAYS,
          },
        };
      }

      const ageDays = Math.floor(
        (ctx.clock.now().getTime() - newest.generatedAt.getTime()) / 86_400_000
      );
      const stale = ageDays > ACCESS_REVIEW_MAX_AGE_DAYS;

      return {
        outcome: stale ? ("FAIL" as const) : ("PASS" as const),
        summary:
          `${org.slug}: newest access review is ${ageDays} day(s) old ` +
          `(limit ${ACCESS_REVIEW_MAX_AGE_DAYS}).`,
        findings: stale
          ? [
              {
                subject: `organization:${org.slug}`,
                detail:
                  `Newest access review was generated ${ageDays} days ago, past the ` +
                  `${ACCESS_REVIEW_MAX_AGE_DAYS}-day limit. Generate one for the ` +
                  `current period.`,
              },
            ]
          : [],
        details: {
          organizationSlug: org.slug,
          newestSnapshotId: newest.id,
          newestGeneratedAt: newest.generatedAt.toISOString(),
          newestPeriodEnd: newest.periodEnd.toISOString(),
          ageDays,
          maxAgeDays: ACCESS_REVIEW_MAX_AGE_DAYS,
        },
      };
    }),
});
