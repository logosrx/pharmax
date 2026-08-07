// Probe: every principal holding an elevated role has verified MFA.
//
// "Elevated" is deliberately NOT redefined here. It reuses
// ELEVATED_ROLE_CODES from @pharmax/security, the same constant the
// quarterly access review highlights against. Two competing
// definitions of "privileged" is precisely the silent inconsistency
// this module exists to catch — if the list needs changing, it
// changes in one place and both the review and this probe move
// together.
//
// An enrollment counts only when `verifiedAt` is set and `disabledAt`
// is not. A started-but-abandoned TOTP enrollment protects nothing,
// and treating it as coverage would report the strongest possible
// evidence for the weakest possible state.

import { ELEVATED_ROLE_CODES } from "@pharmax/security";

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";
import type { ComplianceFinding } from "../../types.js";

export const mfaElevatedRoleEnrollmentCheck = defineCheck({
  code: "identity.mfa.elevated_role_enrollment",
  title: "Elevated-role principals have verified MFA",
  description:
    "For each active organization, every user holding one of the elevated roles " +
    "(OrgAdmin, Pharmacist, BillingManager, SecurityOfficer, ComplianceOfficer, " +
    "PharmacistInCharge) must have at least one verified, non-disabled MFA " +
    "enrollment. Fails with one finding per uncovered principal.",
  severity: "CRITICAL",
  cadence: "DAILY",
  intervalMinutes: 1440,
  controlCodes: ["CC6.1-4"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      // Only principals who can actually sign in are in scope.
      // A TERMINATED user retaining an elevated grant is a real
      // finding, but it belongs to the deprovisioning probe — mixing
      // it in here would make one FAIL mean two different things.
      const elevatedUsers = await ctx.prisma.user.findMany({
        where: {
          organizationId: org.id,
          status: { in: ["ACTIVE", "INVITED"] },
          userRoles: { some: { role: { code: { in: [...ELEVATED_ROLE_CODES] } } } },
        },
        select: {
          id: true,
          userRoles: { select: { role: { select: { code: true } } } },
          mfaEnrollments: {
            where: { verifiedAt: { not: null }, disabledAt: null },
            select: { id: true },
          },
        },
        orderBy: { id: "asc" },
      });

      const findings: ComplianceFinding[] = elevatedUsers
        .filter((user) => user.mfaEnrollments.length === 0)
        .map((user) => {
          const elevatedCodes = user.userRoles
            .map((ur) => ur.role.code)
            .filter((code) => ELEVATED_ROLE_CODES.includes(code))
            .sort();
          return {
            subject: `user:${user.id}`,
            detail:
              `Holds elevated role(s) ${elevatedCodes.join(", ")} with no verified, ` +
              `enabled MFA enrollment.`,
          };
        });

      const covered = elevatedUsers.length - findings.length;
      return {
        outcome: findings.length === 0 ? "PASS" : "FAIL",
        summary:
          `${org.slug}: ${covered} of ${elevatedUsers.length} elevated-role ` +
          `principals have verified MFA.`,
        findings,
        details: {
          organizationSlug: org.slug,
          elevatedPrincipalCount: elevatedUsers.length,
          coveredPrincipalCount: covered,
          uncoveredPrincipalCount: findings.length,
          elevatedRoleCodes: [...ELEVATED_ROLE_CODES],
        },
      };
    }),
});
