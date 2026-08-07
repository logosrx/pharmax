// Helper for probes that must reach a verdict PER TENANT.
//
// Most posture questions are platform-wide ("is branch protection
// on?"), but the ones auditors care most about are per-tenant: an
// access review is stale for THIS pharmacy, the audit chain head is
// wrong for THAT one. Rolling those into a single platform verdict
// would hide which tenant is affected behind an aggregate count, and
// "1 of 9 organizations is non-compliant" is not something you can
// hand to a remediation owner.
//
// Two behaviours worth stating because they are easy to get wrong:
//
//   - Only ACTIVE organizations are examined. A suspended tenant is
//     not operating, so holding its stale access review against the
//     current period would generate findings nobody can act on.
//
//   - A platform with no active organizations returns exactly one
//     NOT_APPLICABLE verdict rather than an empty array, because the
//     runner treats an empty array as a probe bug. "Nothing to check"
//     is a real, reportable state; "I returned nothing" is not.

import type { ComplianceCheckContext, ComplianceVerdict } from "../types.js";

/** The tenant identity a per-org probe is handed. */
export interface ComplianceOrganizationRef {
  readonly id: string;
  /** Human-readable tenant handle. Not PHI; safe in a digest email. */
  readonly slug: string;
}

/**
 * Run `evaluateOne` for every ACTIVE organization and collect the
 * verdicts, stamping `subjectOrganizationId` so the caller cannot
 * forget to.
 */
export async function forEachActiveOrganization(
  ctx: ComplianceCheckContext,
  evaluateOne: (
    org: ComplianceOrganizationRef
  ) => Promise<Omit<ComplianceVerdict, "subjectOrganizationId">>
): Promise<readonly ComplianceVerdict[]> {
  const organizations = await ctx.prisma.organization.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });

  if (organizations.length === 0) {
    return [
      {
        outcome: "NOT_APPLICABLE",
        summary: "No active organizations to evaluate.",
        findings: [],
        details: { activeOrganizationCount: 0 },
        subjectOrganizationId: null,
      },
    ];
  }

  const verdicts: ComplianceVerdict[] = [];
  for (const org of organizations) {
    const partial = await evaluateOne(org);
    verdicts.push({ ...partial, subjectOrganizationId: org.id });
  }
  return verdicts;
}
