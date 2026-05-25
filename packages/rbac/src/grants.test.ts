// Scope matching matrix.
//
// This is the security-critical decision table. Every cell here
// determines whether a grant ALLOWS an action in a given context.
// Bugs here mean either:
//   - Over-permissioning (a SITE-pinned grant lets a Pharmacist
//     PV1 at another site) → HIPAA / SOC 2 incident.
//   - Under-permissioning (an org-wide admin can't act) → broken
//     product.
//
// Both failure modes warrant the same test rigor.

import { describe, expect, it } from "vitest";

import { RoleScope } from "@pharmax/database";
import { buildTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { appliesInContext, unionPermissions, type ResolvedGrant } from "./grants.js";
import { PERMISSIONS } from "./permissions.js";

function grant(overrides: Partial<ResolvedGrant>): ResolvedGrant {
  return {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_READ]),
    ...overrides,
  };
}

// Helper: build a TenancyContext while honoring exactOptionalPropertyTypes
// (i.e. an override of `siteId: undefined` removes the key, not sets it).
function ctx(overrides: Record<string, unknown> = {}): TenancyContext {
  const base: Record<string, unknown> = {
    organizationId: "org-1",
    siteId: "site-1",
    clinicId: "clinic-1",
    teamId: "team-1",
    actor: { userId: "user-1", correlationId: "01ULID000000000000000000000" },
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return buildTenancyContext(base as unknown as Parameters<typeof buildTenancyContext>[0]);
}

describe("appliesInContext — org-wide grant", () => {
  it("applies in any context inside the same org", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: null, teamId: null } });
    expect(appliesInContext(g, ctx({ siteId: "site-A", clinicId: "clinic-Z" }))).toBe(true);
    expect(
      appliesInContext(g, ctx({ siteId: undefined, clinicId: undefined, teamId: undefined }))
    ).toBe(true);
  });
});

describe("appliesInContext — site-pinned grant", () => {
  it("applies when context.siteId matches", () => {
    const g = grant({ grantScope: { siteId: "site-1", clinicId: null, teamId: null } });
    expect(appliesInContext(g, ctx({ siteId: "site-1" }))).toBe(true);
  });

  it("does NOT apply when context.siteId differs", () => {
    const g = grant({ grantScope: { siteId: "site-1", clinicId: null, teamId: null } });
    expect(appliesInContext(g, ctx({ siteId: "site-2" }))).toBe(false);
  });

  it("does NOT apply when context has no siteId", () => {
    const g = grant({ grantScope: { siteId: "site-1", clinicId: null, teamId: null } });
    expect(appliesInContext(g, ctx({ siteId: undefined }))).toBe(false);
  });
});

describe("appliesInContext — clinic-pinned grant", () => {
  it("applies when context.clinicId matches", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: "clinic-1", teamId: null } });
    expect(appliesInContext(g, ctx({ clinicId: "clinic-1" }))).toBe(true);
  });

  it("does NOT apply when context.clinicId differs", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: "clinic-1", teamId: null } });
    expect(appliesInContext(g, ctx({ clinicId: "clinic-2" }))).toBe(false);
  });

  it("does NOT apply when context has no clinicId", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: "clinic-1", teamId: null } });
    expect(appliesInContext(g, ctx({ clinicId: undefined }))).toBe(false);
  });
});

describe("appliesInContext — team-pinned grant", () => {
  it("applies when context.teamId matches", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: null, teamId: "team-1" } });
    expect(appliesInContext(g, ctx({ teamId: "team-1" }))).toBe(true);
  });

  it("does NOT apply when context.teamId differs", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: null, teamId: "team-1" } });
    expect(appliesInContext(g, ctx({ teamId: "team-2" }))).toBe(false);
  });
});

describe("appliesInContext — compound pin (site + clinic)", () => {
  it("applies when BOTH match", () => {
    const g = grant({ grantScope: { siteId: "site-1", clinicId: "clinic-1", teamId: null } });
    expect(appliesInContext(g, ctx({ siteId: "site-1", clinicId: "clinic-1" }))).toBe(true);
  });

  it("does NOT apply when only one matches", () => {
    const g = grant({ grantScope: { siteId: "site-1", clinicId: "clinic-1", teamId: null } });
    expect(appliesInContext(g, ctx({ siteId: "site-1", clinicId: "clinic-2" }))).toBe(false);
    expect(appliesInContext(g, ctx({ siteId: "site-2", clinicId: "clinic-1" }))).toBe(false);
  });
});

describe("unionPermissions", () => {
  it("merges multiple grants into a single set", () => {
    const a = grant({ permissions: new Set([PERMISSIONS.ORDERS_READ, PERMISSIONS.PV1_APPROVE]) });
    const b = grant({ permissions: new Set([PERMISSIONS.PV1_REJECT, PERMISSIONS.PV1_APPROVE]) });
    const u = unionPermissions([a, b]);
    expect(Array.from(u).sort()).toEqual(
      [PERMISSIONS.ORDERS_READ, PERMISSIONS.PV1_APPROVE, PERMISSIONS.PV1_REJECT].sort()
    );
  });

  it("returns an empty set for an empty input", () => {
    const u = unionPermissions([]);
    expect(u.size).toBe(0);
  });
});
