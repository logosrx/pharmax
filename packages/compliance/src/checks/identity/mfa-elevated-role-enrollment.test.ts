import { clock as clockNs } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import { mfaElevatedRoleEnrollmentCheck } from "./mfa-elevated-role-enrollment.js";
import { runComplianceCheck } from "../run-check.js";
import type { ComplianceCheckContext } from "../../types.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const ORG_A = "11111111-1111-7111-a111-111111111111";
const ORG_B = "22222222-2222-7222-a222-222222222222";

interface FakeUser {
  readonly id: string;
  readonly elevatedRoleCodes: readonly string[];
  readonly hasVerifiedMfa: boolean;
}

/**
 * Minimal Prisma stand-in. Records the `where` clauses the probe
 * builds so the tests can assert on scoping — the org filter and the
 * verified/enabled MFA filter are both load-bearing, and a fake that
 * ignored them would let a scoping regression pass.
 */
function buildPrisma(seed: {
  readonly organizations: ReadonlyArray<{ id: string; slug: string; status?: string }>;
  readonly usersByOrg: Readonly<Record<string, readonly FakeUser[]>>;
}) {
  const calls: Array<{ model: string; args: Record<string, unknown> }> = [];

  const prisma = {
    organization: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: "organization", args });
        const where = args["where"] as { status?: string } | undefined;
        return seed.organizations
          .filter((o) => where?.status === undefined || (o.status ?? "ACTIVE") === where.status)
          .map((o) => ({ id: o.id, slug: o.slug }));
      },
    },
    user: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: "user", args });
        const where = args["where"] as { organizationId: string };
        const users = seed.usersByOrg[where.organizationId] ?? [];
        return users
          .filter((u) => u.elevatedRoleCodes.length > 0)
          .map((u) => ({
            id: u.id,
            userRoles: u.elevatedRoleCodes.map((code) => ({ role: { code } })),
            // Mirrors the probe's nested filter: only verified and
            // not-disabled enrollments are returned.
            mfaEnrollments: u.hasVerifiedMfa ? [{ id: `mfa-${u.id}` }] : [],
          }));
      },
    },
  };

  return { prisma, calls };
}

function buildContext(prisma: unknown): ComplianceCheckContext {
  return {
    prisma: prisma as ComplianceCheckContext["prisma"],
    clock: clockNs.createFrozenClock(NOW),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ComplianceCheckContext["logger"],
  };
}

describe("identity.mfa.elevated_role_enrollment", () => {
  it("passes when every elevated principal has a verified enrollment", async () => {
    const { prisma } = buildPrisma({
      organizations: [{ id: ORG_A, slug: "acme" }],
      usersByOrg: {
        [ORG_A]: [
          { id: "u1", elevatedRoleCodes: ["OrgAdmin"], hasVerifiedMfa: true },
          { id: "u2", elevatedRoleCodes: ["Pharmacist"], hasVerifiedMfa: true },
        ],
      },
    });

    const records = await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma));

    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("PASS");
    expect(records[0]!.subjectOrganizationId).toBe(ORG_A);
    expect(records[0]!.summary).toBe("acme: 2 of 2 elevated-role principals have verified MFA.");
    expect(records[0]!.findingCount).toBe(0);
  });

  it("fails with one finding per uncovered principal, naming the elevated roles held", async () => {
    const { prisma } = buildPrisma({
      organizations: [{ id: ORG_A, slug: "acme" }],
      usersByOrg: {
        [ORG_A]: [
          { id: "u1", elevatedRoleCodes: ["OrgAdmin"], hasVerifiedMfa: true },
          {
            id: "u2",
            elevatedRoleCodes: ["Pharmacist", "SecurityOfficer"],
            hasVerifiedMfa: false,
          },
        ],
      },
    });

    const record = (
      await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma))
    )[0]!;

    expect(record.outcome).toBe("FAIL");
    expect(record.findingCount).toBe(1);
    const findings = record.details["findings"] as ReadonlyArray<Record<string, string>>;
    expect(findings[0]!["subject"]).toBe("user:u2");
    // Roles are sorted so the finding text is stable across runs and
    // a digest diff means a real change, not a reordering.
    expect(findings[0]!["detail"]).toContain("Pharmacist, SecurityOfficer");
    expect(record.details["uncoveredPrincipalCount"]).toBe(1);
    expect(record.details["coveredPrincipalCount"]).toBe(1);
  });

  it("returns an independent verdict per tenant rather than one aggregate", async () => {
    const { prisma } = buildPrisma({
      organizations: [
        { id: ORG_A, slug: "acme" },
        { id: ORG_B, slug: "borden" },
      ],
      usersByOrg: {
        [ORG_A]: [{ id: "u1", elevatedRoleCodes: ["OrgAdmin"], hasVerifiedMfa: true }],
        [ORG_B]: [{ id: "u2", elevatedRoleCodes: ["OrgAdmin"], hasVerifiedMfa: false }],
      },
    });

    const records = await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma));

    expect(records).toHaveLength(2);
    expect(records.map((r) => [r.subjectOrganizationId, r.outcome])).toEqual([
      [ORG_A, "PASS"],
      [ORG_B, "FAIL"],
    ]);
  });

  it("scopes the user query to the organization and to sign-in-capable statuses", async () => {
    const { prisma, calls } = buildPrisma({
      organizations: [{ id: ORG_A, slug: "acme" }],
      usersByOrg: { [ORG_A]: [] },
    });

    await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma));

    const userCall = calls.find((c) => c.model === "user");
    const where = userCall?.args["where"] as Record<string, unknown>;
    expect(where["organizationId"]).toBe(ORG_A);
    // TERMINATED users are the deprovisioning probe's business; mixing
    // them in here would make one FAIL mean two different things.
    expect(where["status"]).toEqual({ in: ["ACTIVE", "INVITED"] });
  });

  it("only examines ACTIVE organizations", async () => {
    const { prisma, calls } = buildPrisma({
      organizations: [
        { id: ORG_A, slug: "acme", status: "ACTIVE" },
        { id: ORG_B, slug: "suspended-co", status: "SUSPENDED" },
      ],
      usersByOrg: {
        [ORG_A]: [{ id: "u1", elevatedRoleCodes: ["OrgAdmin"], hasVerifiedMfa: true }],
        [ORG_B]: [{ id: "u9", elevatedRoleCodes: ["OrgAdmin"], hasVerifiedMfa: false }],
      },
    });

    const records = await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma));

    expect((calls[0]!.args["where"] as Record<string, unknown>)["status"]).toBe("ACTIVE");
    expect(records).toHaveLength(1);
    expect(records[0]!.subjectOrganizationId).toBe(ORG_A);
  });

  it("reports NOT_APPLICABLE rather than an empty result when there are no active tenants", async () => {
    const { prisma } = buildPrisma({ organizations: [], usersByOrg: {} });

    const records = await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma));

    // An empty array would be treated as a probe bug by the runner,
    // and "nothing to check" is a real state that must be reportable.
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("NOT_APPLICABLE");
    expect(records[0]!.errorCode).toBeNull();
  });

  it("passes vacuously when a tenant has no elevated principals at all", async () => {
    const { prisma } = buildPrisma({
      organizations: [{ id: ORG_A, slug: "acme" }],
      usersByOrg: { [ORG_A]: [{ id: "u1", elevatedRoleCodes: [], hasVerifiedMfa: false }] },
    });

    const record = (
      await runComplianceCheck(mfaElevatedRoleEnrollmentCheck, buildContext(prisma))
    )[0]!;

    expect(record.outcome).toBe("PASS");
    expect(record.details["elevatedPrincipalCount"]).toBe(0);
  });
});
