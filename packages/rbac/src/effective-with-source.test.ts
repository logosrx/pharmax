// getEffectivePermissionsWithSource tests.
//
// The source-aware view is what powers the admin role editor. We
// pin:
//   - Every permission appears EXACTLY ONCE in the result.
//   - role_default attribution lists the contributing role grants.
//   - override_granted attribution shows up when overrides supply it.
//   - override_revoked WINS over role_default and over override_granted
//     (the most explicit administrative act always wins).
//   - not_available appears when neither roles nor overrides supply it.
//   - The deny convenience helper returns the same set minus granted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoleScope } from "@pharmax/database";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { configureRbac, resetRbacConfigurationForTests } from "./configure.js";
import {
  EmptyPermissionOverrideSource,
  getDeniedPermissionsWithReason,
  getEffectivePermissionsWithSource,
  type PermissionOverrideSource,
} from "./effective-with-source.js";
import type { ResolvedGrant } from "./grants.js";
import { InMemoryPermissionLoader } from "./loader.js";
import { ALL_PERMISSION_CODES, PERMISSIONS, type PermissionCode } from "./permissions.js";
import { clearContextCacheForTests } from "./resolver.js";

function ctxFor() {
  return buildTenancyContext({
    organizationId: "org-1",
    actor: { userId: "user-1", correlationId: "01ULID000000000000000000000" },
  });
}

function adminGrants(): ReadonlyArray<ResolvedGrant> {
  return [
    {
      roleScope: RoleScope.ORGANIZATION,
      grantScope: { siteId: null, clinicId: null, teamId: null },
      permissions: new Set<PermissionCode>([PERMISSIONS.ORDERS_READ, PERMISSIONS.PV1_APPROVE]),
    },
  ];
}

class FakeOverrideSource implements PermissionOverrideSource {
  public constructor(
    private readonly granted: ReadonlyArray<PermissionCode>,
    private readonly revoked: ReadonlyArray<PermissionCode>
  ) {}
  public async load(): Promise<{
    readonly granted: ReadonlySet<PermissionCode>;
    readonly revoked: ReadonlySet<PermissionCode>;
  }> {
    return {
      granted: new Set(this.granted),
      revoked: new Set(this.revoked),
    };
  }
}

afterEach(() => {
  resetRbacConfigurationForTests();
});

describe("getEffectivePermissionsWithSource — shape", () => {
  beforeEach(() => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
  });

  it("returns one row per registered permission, in registry order", async () => {
    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const result = await getEffectivePermissionsWithSource();
      expect(result).toHaveLength(ALL_PERMISSION_CODES.length);
      const codes = result.map((r) => r.permission);
      expect(codes).toEqual([...ALL_PERMISSION_CODES]);
    });
  });
});

describe("getEffectivePermissionsWithSource — attribution", () => {
  it("marks granted-from-role permissions as role_default with role attribution", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const result = await getEffectivePermissionsWithSource();
      const pv1 = result.find((r) => r.permission === PERMISSIONS.PV1_APPROVE);
      expect(pv1).toMatchObject({
        permission: PERMISSIONS.PV1_APPROVE,
        granted: true,
        source: "role_default",
      });
      expect(pv1?.attribution[0]?.kind).toBe("role");
      expect(pv1?.attribution[0]?.label).toContain("scope=");
    });
  });

  it("marks not-granted permissions as not_available with empty attribution", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const result = await getEffectivePermissionsWithSource();
      const billing = result.find((r) => r.permission === PERMISSIONS.BILLING_MANAGE);
      expect(billing).toMatchObject({
        permission: PERMISSIONS.BILLING_MANAGE,
        granted: false,
        source: "not_available",
      });
      expect(billing?.attribution).toEqual([]);
    });
  });

  it("override_granted promotes a not-in-role permission", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
    const ctx = ctxFor();
    const overrides = new FakeOverrideSource([PERMISSIONS.BILLING_MANAGE], []);
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const result = await getEffectivePermissionsWithSource(overrides);
      const billing = result.find((r) => r.permission === PERMISSIONS.BILLING_MANAGE);
      expect(billing).toMatchObject({
        permission: PERMISSIONS.BILLING_MANAGE,
        granted: true,
        source: "override_granted",
      });
    });
  });

  it("override_revoked WINS over role_default", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
    const ctx = ctxFor();
    const overrides = new FakeOverrideSource([], [PERMISSIONS.PV1_APPROVE]);
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const result = await getEffectivePermissionsWithSource(overrides);
      const pv1 = result.find((r) => r.permission === PERMISSIONS.PV1_APPROVE);
      expect(pv1).toMatchObject({
        permission: PERMISSIONS.PV1_APPROVE,
        granted: false,
        source: "override_revoked",
      });
    });
  });

  it("override_revoked WINS over override_granted (most explicit admin act)", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: [] },
      ]),
    });
    const ctx = ctxFor();
    const overrides = new FakeOverrideSource(
      [PERMISSIONS.BILLING_MANAGE],
      [PERMISSIONS.BILLING_MANAGE]
    );
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const result = await getEffectivePermissionsWithSource(overrides);
      const billing = result.find((r) => r.permission === PERMISSIONS.BILLING_MANAGE);
      expect(billing?.source).toBe("override_revoked");
      expect(billing?.granted).toBe(false);
    });
  });

  it("EmptyPermissionOverrideSource is the default and matches the absence of overrides", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const without = await getEffectivePermissionsWithSource();
      const withEmpty = await getEffectivePermissionsWithSource(
        new EmptyPermissionOverrideSource()
      );
      expect(without).toEqual(withEmpty);
    });
  });
});

describe("getDeniedPermissionsWithReason", () => {
  beforeEach(() => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: adminGrants() },
      ]),
    });
  });

  it("lists every NOT-granted permission with a description", async () => {
    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const denied = await getDeniedPermissionsWithReason();
      const grantedCount = 2; // ORDERS_READ + PV1_APPROVE
      expect(denied).toHaveLength(ALL_PERMISSION_CODES.length - grantedCount);
      for (const d of denied) {
        expect(d.description.length).toBeGreaterThan(0);
        expect(d.reason).toBe("not_available");
      }
    });
  });

  it("flags override_revoked separately from not_available", async () => {
    const ctx = ctxFor();
    const overrides = new FakeOverrideSource([], [PERMISSIONS.PV1_APPROVE]);
    await withTenancyContext(ctx, async () => {
      clearContextCacheForTests(ctx);
      const denied = await getDeniedPermissionsWithReason(overrides);
      const pv1 = denied.find((d) => d.permission === PERMISSIONS.PV1_APPROVE);
      expect(pv1?.reason).toBe("override_revoked");
    });
  });
});
