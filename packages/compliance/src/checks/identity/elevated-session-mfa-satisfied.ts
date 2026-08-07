// Probe: live sessions for elevated principals cleared MFA.
//
// The enrollment probe answers "does this person HAVE a second
// factor". This one answers the question that actually matters at
// the moment of access: "did the session they are using right now
// present it". Those come apart in practice — an MFA requirement
// introduced after a long-lived session was minted, or a bypass path
// added for a support flow, leaves fully enrolled users operating on
// sessions that never satisfied the challenge.
//
// Only LIVE sessions count: not revoked, and past neither the idle
// nor the absolute expiry. An expired session cannot be used, so
// holding its mfaSatisfied flag against the control would generate
// findings for access that is already impossible.

import { ELEVATED_ROLE_CODES } from "@pharmax/security";

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";
import type { ComplianceFinding } from "../../types.js";

const MAX_ENUMERATED_FINDINGS = 25;

export const elevatedSessionMfaSatisfiedCheck = defineCheck({
  code: "identity.session.elevated_mfa_satisfied",
  title: "Live elevated-role sessions satisfied MFA",
  description:
    "For each active organization, every live auth_session belonging to a user who " +
    "holds an elevated role must have mfaSatisfied = true. Live means not revoked " +
    "and past neither idleExpiresAt nor absoluteExpiresAt. Catches elevated access " +
    "riding on sessions minted before, or around, the MFA requirement.",
  severity: "CRITICAL",
  cadence: "CONTINUOUS",
  intervalMinutes: 60,
  controlCodes: ["CC6.1-4"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      const now = ctx.clock.now();
      const liveElevated = {
        organizationId: org.id,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
        user: {
          userRoles: { some: { role: { code: { in: [...ELEVATED_ROLE_CODES] } } } },
        },
      };

      const [liveCount, unsatisfiedCount, sample] = await Promise.all([
        ctx.prisma.authSession.count({ where: liveElevated }),
        ctx.prisma.authSession.count({ where: { ...liveElevated, mfaSatisfied: false } }),
        ctx.prisma.authSession.findMany({
          where: { ...liveElevated, mfaSatisfied: false },
          // ipAddress and userAgent are deliberately not selected.
          // They identify an operator's device and location, and this
          // row is exported as evidence and mailed in digests.
          select: { id: true, userId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take: MAX_ENUMERATED_FINDINGS,
        }),
      ]);

      const findings: ComplianceFinding[] = sample.map((row) => ({
        subject: `auth_session:${row.id}`,
        detail:
          `Live session for elevated principal user:${row.userId} has ` +
          `mfaSatisfied = false; minted ${row.createdAt.toISOString()}.`,
      }));

      return {
        outcome: unsatisfiedCount === 0 ? "PASS" : "FAIL",
        summary:
          `${org.slug}: ${unsatisfiedCount} of ${liveCount} live elevated-role ` +
          `session(s) did not satisfy MFA.`,
        findings,
        details: {
          organizationSlug: org.slug,
          liveElevatedSessionCount: liveCount,
          mfaUnsatisfiedSessionCount: unsatisfiedCount,
          enumeratedFindingCount: findings.length,
          findingsTruncated: unsatisfiedCount > findings.length,
          elevatedRoleCodes: [...ELEVATED_ROLE_CODES],
        },
      };
    }),
});
