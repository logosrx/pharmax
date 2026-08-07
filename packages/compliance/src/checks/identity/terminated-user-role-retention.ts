// Probe: deprovisioned principals retain no role grants.
//
// The access-review report surfaces this quarterly for a human to
// read. Quarterly is the audit obligation, not the risk window: a
// terminated pharmacist who keeps a Pharmacist grant for eleven weeks
// is eleven weeks of exposure that the review will eventually
// document rather than prevent. Checking daily turns a
// point-in-time attestation into an actual control.
//
// SUSPENDED is intentionally NOT a finding. Suspension is reversible
// by design (leave of absence, investigation) and the grants are
// meant to survive it; the sign-in path is what refuses the session.
// TERMINATED is terminal, so a surviving grant there is unambiguous.

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";
import type { ComplianceFinding } from "../../types.js";

export const terminatedUserRoleRetentionCheck = defineCheck({
  code: "identity.rbac.terminated_user_role_retention",
  title: "Terminated principals hold no role grants",
  description:
    "For each active organization, no user with status TERMINATED may retain a " +
    "user_role assignment. Fails with one finding per terminated principal that " +
    "still holds grants. SUSPENDED users are out of scope because suspension is " +
    "reversible and the sign-in path, not the grant, is what blocks them.",
  severity: "HIGH",
  cadence: "DAILY",
  intervalMinutes: 1440,
  controlCodes: ["CC6.5-1"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      const terminated = await ctx.prisma.user.findMany({
        where: { organizationId: org.id, status: "TERMINATED" },
        select: {
          id: true,
          userRoles: { select: { role: { select: { code: true } } } },
        },
        orderBy: { id: "asc" },
      });

      const findings: ComplianceFinding[] = terminated
        .filter((user) => user.userRoles.length > 0)
        .map((user) => ({
          subject: `user:${user.id}`,
          detail:
            `Status TERMINATED but still holds ${user.userRoles.length} role ` +
            `grant(s): ${user.userRoles
              .map((ur) => ur.role.code)
              .sort()
              .join(", ")}.`,
        }));

      return {
        outcome: findings.length === 0 ? "PASS" : "FAIL",
        summary:
          `${org.slug}: ${findings.length} of ${terminated.length} terminated ` +
          `principals still hold role grants.`,
        findings,
        details: {
          organizationSlug: org.slug,
          terminatedPrincipalCount: terminated.length,
          terminatedWithGrantsCount: findings.length,
        },
      };
    }),
});
