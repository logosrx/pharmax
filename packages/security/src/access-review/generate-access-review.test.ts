import { describe, expect, it } from "vitest";

import {
  INACTIVE_USER_THRESHOLD_DAYS,
  OrganizationNotFoundForAccessReviewError,
  STALE_ASSIGNMENT_THRESHOLD_DAYS,
  generateAccessReview,
  type AccessReviewClient,
} from "./generate-access-review.js";

const ORG = "11111111-1111-7111-a111-111111111111";

interface FakeUserSpec {
  readonly id: string;
  readonly email: string;
  readonly displayName?: string;
  readonly status?: string;
  readonly clerkUserId?: string | null;
  readonly lastLoginAt?: Date | null;
  readonly roles: ReadonlyArray<{
    readonly userRoleId: string;
    readonly roleCode: string;
    readonly roleName?: string;
    readonly scope?: "ORGANIZATION" | "SITE" | "CLINIC" | "TEAM";
    readonly siteId?: string | null;
    readonly clinicId?: string | null;
    readonly teamId?: string | null;
    readonly grantedAt: Date;
    readonly permissions: ReadonlyArray<string>;
  }>;
}

function buildClient(users: ReadonlyArray<FakeUserSpec>): AccessReviewClient {
  return {
    async loadOrganization(args) {
      if (args.organizationId !== ORG) return null;
      return { id: ORG, slug: "acme" };
    },
    async loadUsersWithRoles(args) {
      if (args.organizationId !== ORG) return [];
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName ?? u.email,
        status: u.status ?? "ACTIVE",
        clerkUserId: u.clerkUserId ?? null,
        lastLoginAt: u.lastLoginAt ?? null,
        userRoles: u.roles.map((r) => ({
          id: r.userRoleId,
          createdAt: r.grantedAt,
          organizationId: ORG,
          siteId: r.siteId ?? null,
          clinicId: r.clinicId ?? null,
          teamId: r.teamId ?? null,
          role: {
            id: `role-${r.roleCode}`,
            code: r.roleCode,
            name: r.roleName ?? r.roleCode,
            scope: r.scope ?? "ORGANIZATION",
            rolePermissions: r.permissions.map((code) => ({ permission: { code } })),
          },
        })),
      }));
    },
  };
}

const NOW = new Date("2026-05-24T12:00:00.000Z");
const PERIOD_START = new Date("2026-04-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-05-24T00:00:00.000Z");

describe("generateAccessReview", () => {
  it("throws OrganizationNotFoundForAccessReviewError when the org is unknown", async () => {
    const client = buildClient([]);
    await expect(
      generateAccessReview({
        organizationId: "00000000-0000-0000-0000-000000000000",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        client,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(OrganizationNotFoundForAccessReviewError);
  });

  it("validates the period bounds", async () => {
    const client = buildClient([]);
    await expect(
      generateAccessReview({
        organizationId: ORG,
        periodStart: PERIOD_END,
        periodEnd: PERIOD_START,
        client,
        now: NOW,
      })
    ).rejects.toThrow(/periodEnd must be strictly after periodStart/);
  });

  it("returns an empty report for an org with no users", async () => {
    const client = buildClient([]);
    const report = await generateAccessReview({
      organizationId: ORG,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      client,
      now: NOW,
    });
    expect(report.principals).toHaveLength(0);
    expect(report.summary.totalPrincipals).toBe(0);
    expect(report.summary.principalsWithElevatedRoles).toHaveLength(0);
  });

  it("flags elevated roles, inactive principals, stale assignments, and crypto-shred-capable roles", async () => {
    const now = NOW;
    const longAgo = new Date(now.getTime() - (STALE_ASSIGNMENT_THRESHOLD_DAYS + 10) * 86_400_000);
    const recently = new Date(now.getTime() - 5 * 86_400_000);
    const oldLogin = new Date(now.getTime() - (INACTIVE_USER_THRESHOLD_DAYS + 5) * 86_400_000);
    const recentLogin = new Date(now.getTime() - 1 * 86_400_000);

    const client = buildClient([
      {
        id: "user-1",
        email: "owner@acme.test",
        lastLoginAt: oldLogin,
        roles: [
          {
            userRoleId: "ur-1",
            roleCode: "OrgAdmin",
            grantedAt: longAgo,
            permissions: ["orgs.read", "patients.crypto_shred"],
          },
        ],
      },
      {
        id: "user-2",
        email: "tech@acme.test",
        lastLoginAt: recentLogin,
        roles: [
          {
            userRoleId: "ur-2",
            roleCode: "TypingTech",
            grantedAt: recently,
            permissions: ["typing.start"],
          },
        ],
      },
      {
        id: "user-3",
        email: "never-logged-in@acme.test",
        lastLoginAt: null,
        roles: [
          {
            userRoleId: "ur-3",
            roleCode: "Pharmacist",
            grantedAt: recently,
            permissions: ["pv1.approve"],
          },
        ],
      },
    ]);
    const report = await generateAccessReview({
      organizationId: ORG,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      client,
      now,
    });

    expect(report.organizationSlug).toBe("acme");
    expect(report.summary.totalPrincipals).toBe(3);
    expect(report.summary.principalsWithElevatedRoles).toEqual(
      expect.arrayContaining(["user-1", "user-3"])
    );
    expect(report.summary.principalsWithElevatedRoles).not.toContain("user-2");
    expect(report.summary.inactivePrincipals).toEqual(expect.arrayContaining(["user-1", "user-3"]));
    expect(report.summary.staleAssignments).toEqual([
      expect.objectContaining({ userId: "user-1", userRoleId: "ur-1", roleCode: "OrgAdmin" }),
    ]);
    expect(report.summary.cryptoShredCapableRoles).toEqual(["OrgAdmin"]);

    const owner = report.principals.find((p) => p.userId === "user-1");
    expect(owner?.effectivePermissions).toEqual(["orgs.read", "patients.crypto_shred"]);
    expect(owner?.assignments[0]?.isElevated).toBe(true);
  });
});
