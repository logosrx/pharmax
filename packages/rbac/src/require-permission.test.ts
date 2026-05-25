// requirePermission contract tests.
//
// The end-to-end behavior these tests pin:
//   - allow path: grant has the permission AND grant scope matches
//     context → returns silently.
//   - deny paths:
//       * grant missing the permission entirely
//       * grant has the permission but scope mismatches active context
//       * no grants at all for this actor
//   - configuration:
//       * calling `requirePermission` without `configureRbac` throws
//         InternalError(RBAC_NOT_CONFIGURED)
//       * `resetRbacConfigurationForTests` clears the singleton
//   - per-context caching:
//       * loader is called ONCE for repeated calls under the same
//         TenancyContext object
//       * loader is called AGAIN when a fresh context is built
//   - context delegation:
//       * no active tenancy context → TENANCY_NO_CONTEXT (delegated
//         to @pharmax/tenancy)
//       * system context → TENANCY_NO_CONTEXT (system context is
//         not a user, can't be permission-checked)
//   - unknown permission code → PERMISSION_UNKNOWN (InternalError)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoleScope } from "@pharmax/database";
import {
  buildTenancyContext,
  withSystemContext,
  withTenancyContext,
  type TenancyContext,
} from "@pharmax/tenancy";

import { configureRbac, resetRbacConfigurationForTests } from "./configure.js";
import type { ResolvedGrant } from "./grants.js";
import { InMemoryPermissionLoader, type EffectivePermissionLoader } from "./loader.js";
import { PERMISSIONS } from "./permissions.js";
import { clearContextCacheForTests } from "./resolver.js";
import { getEffectivePermissions, hasPermission, requirePermission } from "./require-permission.js";

// Helper: build a TenancyContext while honoring exactOptionalPropertyTypes
// (i.e. an override of `siteId: undefined` removes the key, not sets it).
function ctxFor(overrides: Record<string, unknown> = {}): TenancyContext {
  const base: Record<string, unknown> = {
    organizationId: "org-1",
    actor: { userId: "user-1", correlationId: "01ULID000000000000000000000" },
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return buildTenancyContext(base as unknown as Parameters<typeof buildTenancyContext>[0]);
}

function orgWideAdminGrants(): ReadonlyArray<ResolvedGrant> {
  return [
    {
      roleScope: RoleScope.ORGANIZATION,
      grantScope: { siteId: null, clinicId: null, teamId: null },
      permissions: new Set([
        PERMISSIONS.ORDERS_READ,
        PERMISSIONS.PV1_APPROVE,
        PERMISSIONS.PV1_REJECT,
      ]),
    },
  ];
}

function pharmacistAtSiteGrants(siteId: string): ReadonlyArray<ResolvedGrant> {
  return [
    {
      roleScope: RoleScope.SITE,
      grantScope: { siteId, clinicId: null, teamId: null },
      permissions: new Set([PERMISSIONS.ORDERS_READ, PERMISSIONS.PV1_APPROVE]),
    },
  ];
}

afterEach(() => {
  resetRbacConfigurationForTests();
});

describe("configureRbac", () => {
  it("throws RBAC_NOT_CONFIGURED before configureRbac is called", async () => {
    await withTenancyContext(ctxFor(), async () => {
      await expect(requirePermission(PERMISSIONS.ORDERS_READ)).rejects.toMatchObject({
        code: "RBAC_NOT_CONFIGURED",
      });
    });
  });
});

describe("requirePermission — allow paths", () => {
  beforeEach(() => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
      ]),
    });
  });

  it("returns silently when actor has the permission org-wide", async () => {
    await withTenancyContext(ctxFor(), async () => {
      await expect(requirePermission(PERMISSIONS.PV1_APPROVE)).resolves.toBeUndefined();
    });
  });

  it("allows when site-scoped grant matches context.siteId", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: pharmacistAtSiteGrants("site-A") },
      ]),
    });
    await withTenancyContext(ctxFor({ siteId: "site-A" }), async () => {
      await expect(requirePermission(PERMISSIONS.PV1_APPROVE)).resolves.toBeUndefined();
    });
  });
});

describe("requirePermission — deny paths", () => {
  it("denies when actor has no grants", async () => {
    configureRbac({ loader: new InMemoryPermissionLoader([]) });
    await withTenancyContext(ctxFor(), async () => {
      await expect(requirePermission(PERMISSIONS.PV1_APPROVE)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        metadata: { permission: "pv1.approve", userId: "user-1", organizationId: "org-1" },
      });
    });
  });

  it("denies when grant lacks the requested permission", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
      ]),
    });
    await withTenancyContext(ctxFor(), async () => {
      await expect(requirePermission(PERMISSIONS.BILLING_MANAGE)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  });

  it("denies when site-scoped grant pins to a DIFFERENT site than context", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: pharmacistAtSiteGrants("site-A") },
      ]),
    });
    await withTenancyContext(ctxFor({ siteId: "site-B" }), async () => {
      await expect(requirePermission(PERMISSIONS.PV1_APPROVE)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  });

  it("denies when site-scoped grant requires a siteId but context has none", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: pharmacistAtSiteGrants("site-A") },
      ]),
    });
    await withTenancyContext(ctxFor({ siteId: undefined }), async () => {
      await expect(requirePermission(PERMISSIONS.PV1_APPROVE)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  });
});

describe("requirePermission — context delegation", () => {
  beforeEach(() => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
      ]),
    });
  });

  it("throws TENANCY_NO_CONTEXT when called outside any frame", async () => {
    await expect(requirePermission(PERMISSIONS.ORDERS_READ)).rejects.toMatchObject({
      code: "TENANCY_NO_CONTEXT",
    });
  });

  it("throws TENANCY_NO_CONTEXT when called inside a system context", async () => {
    await withSystemContext("worker-drain", async () => {
      await expect(requirePermission(PERMISSIONS.ORDERS_READ)).rejects.toMatchObject({
        code: "TENANCY_NO_CONTEXT",
      });
    });
  });
});

describe("requirePermission — unknown code", () => {
  it("throws PERMISSION_UNKNOWN for codes not in the registry", async () => {
    configureRbac({ loader: new InMemoryPermissionLoader([]) });
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        // Cast: simulate a stale/typoed call site.
        requirePermission("orders.invent" as never)
      ).rejects.toMatchObject({ code: "PERMISSION_UNKNOWN" });
    });
  });
});

describe("requirePermission — per-context caching", () => {
  it("calls the loader exactly ONCE for repeated checks under the same context", async () => {
    const inMem = new InMemoryPermissionLoader([
      { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
    ]);
    const spied: EffectivePermissionLoader = {
      load: vi.fn(inMem.load.bind(inMem)),
    };
    configureRbac({ loader: spied });

    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      await requirePermission(PERMISSIONS.ORDERS_READ);
      await requirePermission(PERMISSIONS.PV1_APPROVE);
      await requirePermission(PERMISSIONS.PV1_REJECT);
    });

    expect(spied.load).toHaveBeenCalledTimes(1);
  });

  it("calls the loader AGAIN for a freshly-built context", async () => {
    const inMem = new InMemoryPermissionLoader([
      { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
    ]);
    const spied: EffectivePermissionLoader = {
      load: vi.fn(inMem.load.bind(inMem)),
    };
    configureRbac({ loader: spied });

    await withTenancyContext(ctxFor(), () => requirePermission(PERMISSIONS.ORDERS_READ));
    await withTenancyContext(ctxFor(), () => requirePermission(PERMISSIONS.ORDERS_READ));

    expect(spied.load).toHaveBeenCalledTimes(2);
  });

  it("clearContextCacheForTests forces re-load on the same context", async () => {
    const inMem = new InMemoryPermissionLoader([
      { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
    ]);
    const spied: EffectivePermissionLoader = {
      load: vi.fn(inMem.load.bind(inMem)),
    };
    configureRbac({ loader: spied });

    const ctx = ctxFor();
    await withTenancyContext(ctx, async () => {
      await requirePermission(PERMISSIONS.ORDERS_READ);
      clearContextCacheForTests(ctx);
      await requirePermission(PERMISSIONS.ORDERS_READ);
    });

    expect(spied.load).toHaveBeenCalledTimes(2);
  });
});

describe("hasPermission + getEffectivePermissions", () => {
  beforeEach(() => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants() },
      ]),
    });
  });

  it("hasPermission returns true for granted codes, false otherwise", async () => {
    await withTenancyContext(ctxFor(), async () => {
      await expect(hasPermission(PERMISSIONS.PV1_APPROVE)).resolves.toBe(true);
      await expect(hasPermission(PERMISSIONS.BILLING_MANAGE)).resolves.toBe(false);
    });
  });

  it("hasPermission returns false for unknown codes (does NOT throw)", async () => {
    await withTenancyContext(ctxFor(), async () => {
      await expect(hasPermission("not.a.real.code" as never)).resolves.toBe(false);
    });
  });

  it("getEffectivePermissions returns the union of all applicable grants", async () => {
    await withTenancyContext(ctxFor(), async () => {
      const set = await getEffectivePermissions();
      expect(set.has(PERMISSIONS.ORDERS_READ)).toBe(true);
      expect(set.has(PERMISSIONS.PV1_APPROVE)).toBe(true);
      expect(set.has(PERMISSIONS.PV1_REJECT)).toBe(true);
      expect(set.has(PERMISSIONS.BILLING_MANAGE)).toBe(false);
    });
  });
});
