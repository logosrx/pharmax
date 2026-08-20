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

import {
  appliesInContext,
  appliesToScope,
  unionPermissions,
  type ResolvedGrant,
} from "./grants.js";
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

// appliesToScope compares a grant against a RESOURCE's home scope (the
// locked order's siteId/clinicId), not the session context. The key
// semantic difference from appliesInContext: the target's fields are
// concrete `string | null` values read from the row, never "absent",
// so a pinned grant matches iff the row's value equals the pin.
describe("appliesToScope — org-wide grant", () => {
  it("applies to any target scope", () => {
    const g = grant({ grantScope: { siteId: null, clinicId: null, teamId: null } });
    expect(appliesToScope(g, { siteId: "site-A", clinicId: "clinic-Z" })).toBe(true);
    expect(appliesToScope(g, { siteId: null, clinicId: null })).toBe(true);
  });
});

describe("appliesToScope — clinic-pinned grant (the H1 cell)", () => {
  const g = grant({ grantScope: { siteId: null, clinicId: "clinic-A", teamId: null } });

  it("applies to an order homed in the pinned clinic", () => {
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-A" })).toBe(true);
  });

  it("does NOT apply to an order homed in another clinic", () => {
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-B" })).toBe(false);
  });

  it("does NOT apply to an order with no clinic (clinicId null)", () => {
    expect(appliesToScope(g, { siteId: "site-1", clinicId: null })).toBe(false);
  });
});

describe("appliesToScope — site-pinned grant", () => {
  const g = grant({ grantScope: { siteId: "site-1", clinicId: null, teamId: null } });

  it("applies within the pinned site regardless of clinic", () => {
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-X" })).toBe(true);
    expect(appliesToScope(g, { siteId: "site-1", clinicId: null })).toBe(true);
  });

  it("does NOT apply outside the pinned site", () => {
    expect(appliesToScope(g, { siteId: "site-2", clinicId: "clinic-X" })).toBe(false);
    expect(appliesToScope(g, { siteId: null, clinicId: "clinic-X" })).toBe(false);
  });
});

describe("appliesToScope — team-pinned grant", () => {
  const g = grant({ grantScope: { siteId: null, clinicId: null, teamId: "team-1" } });

  it("fails closed when the target carries no team dimension", () => {
    // Orders are homed by site/clinic, not team; a team-only pin can
    // never authorize an order-scope check.
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-A" })).toBe(false);
  });

  it("applies when the target explicitly carries the pinned team", () => {
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-A", teamId: "team-1" })).toBe(
      true
    );
  });
});

describe("appliesToScope — compound pin (site + clinic)", () => {
  const g = grant({ grantScope: { siteId: "site-1", clinicId: "clinic-A", teamId: null } });

  it("requires BOTH dimensions to match", () => {
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-A" })).toBe(true);
    expect(appliesToScope(g, { siteId: "site-1", clinicId: "clinic-B" })).toBe(false);
    expect(appliesToScope(g, { siteId: "site-2", clinicId: "clinic-A" })).toBe(false);
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
