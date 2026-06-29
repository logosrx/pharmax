// PrismaPermissionLoader contract tests.
//
// We don't need a real Postgres for these. The test mocks
// `$queryRaw` and asserts:
//   1. The SQL contains the correct WHERE predicates (org + user
//      isolation by parameter binding, not string concat).
//   2. Rows are correctly grouped by user_role.id so a role with
//      N permissions produces ONE ResolvedGrant with N permissions.
//   3. Multiple user_roles for the same user produce multiple
//      ResolvedGrants.
//   4. Empty result set returns an empty array (not undefined / null).
//   5. Unknown permission codes in the DB are tolerated (so adding
//      a permission in seed before deploying the registry update
//      doesn't crash production).
//
// We use a minimal fake-PrismaClient shape that only implements
// `$queryRaw`. The loader doesn't touch anything else.

import { describe, expect, it, vi } from "vitest";

import { RoleScope } from "@pharmax/database";

import { PERMISSIONS } from "./permissions.js";
import { PrismaPermissionLoader } from "./prisma-permission-loader.js";

interface FakePrisma {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
  // The loader runs `$queryRaw` inside a `$transaction` that first
  // sets the org GUC via `$executeRaw`. The fake invokes the callback
  // with a tx exposing both, so `spy` still observes the SQL call.
  $transaction: (fn: (tx: unknown) => unknown) => unknown;
}

function loaderWith(rows: ReadonlyArray<Record<string, unknown>>): {
  loader: PrismaPermissionLoader;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(rows);
  const fake: FakePrisma = {
    $queryRaw: spy,
    $transaction: (fn) => fn({ $executeRaw: vi.fn(async () => 0), $queryRaw: spy }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { loader: new PrismaPermissionLoader(fake as any), spy };
}

describe("PrismaPermissionLoader.load", () => {
  it("returns an empty array when the user has no grants", async () => {
    const { loader } = loaderWith([]);
    const result = await loader.load({ organizationId: "org-1", userId: "user-1" });
    expect(result).toEqual([]);
  });

  it("groups multiple permission rows under one user_role into one ResolvedGrant", async () => {
    const { loader } = loaderWith([
      {
        userRoleId: "ur-1",
        roleScope: RoleScope.ORGANIZATION,
        siteId: null,
        clinicId: null,
        teamId: null,
        permissionCode: PERMISSIONS.ORDERS_READ,
      },
      {
        userRoleId: "ur-1",
        roleScope: RoleScope.ORGANIZATION,
        siteId: null,
        clinicId: null,
        teamId: null,
        permissionCode: PERMISSIONS.PV1_APPROVE,
      },
      {
        userRoleId: "ur-1",
        roleScope: RoleScope.ORGANIZATION,
        siteId: null,
        clinicId: null,
        teamId: null,
        permissionCode: PERMISSIONS.PV1_REJECT,
      },
    ]);

    const result = await loader.load({ organizationId: "org-1", userId: "user-1" });
    expect(result).toHaveLength(1);
    expect(result[0]?.grantScope).toEqual({ siteId: null, clinicId: null, teamId: null });
    expect(result[0]?.roleScope).toBe(RoleScope.ORGANIZATION);
    expect(Array.from(result[0]?.permissions ?? []).sort()).toEqual(
      [PERMISSIONS.ORDERS_READ, PERMISSIONS.PV1_APPROVE, PERMISSIONS.PV1_REJECT].sort()
    );
  });

  it("produces separate ResolvedGrants for separate user_roles", async () => {
    const { loader } = loaderWith([
      {
        userRoleId: "ur-1",
        roleScope: RoleScope.SITE,
        siteId: "site-A",
        clinicId: null,
        teamId: null,
        permissionCode: PERMISSIONS.PV1_APPROVE,
      },
      {
        userRoleId: "ur-2",
        roleScope: RoleScope.CLINIC,
        siteId: null,
        clinicId: "clinic-X",
        teamId: null,
        permissionCode: PERMISSIONS.ORDERS_READ,
      },
    ]);

    const result = await loader.load({ organizationId: "org-1", userId: "user-1" });
    expect(result).toHaveLength(2);
    const bySite = result.find((g) => g.grantScope.siteId === "site-A");
    const byClinic = result.find((g) => g.grantScope.clinicId === "clinic-X");
    expect(bySite?.permissions.has(PERMISSIONS.PV1_APPROVE)).toBe(true);
    expect(byClinic?.permissions.has(PERMISSIONS.ORDERS_READ)).toBe(true);
  });

  it("tolerates unknown permission codes in the DB without throwing", async () => {
    const { loader } = loaderWith([
      {
        userRoleId: "ur-1",
        roleScope: RoleScope.ORGANIZATION,
        siteId: null,
        clinicId: null,
        teamId: null,
        permissionCode: "fancy.new.code.not.in.registry.yet",
      },
    ]);
    // Should not throw; the unknown code is included verbatim in
    // the set (it'll never match a typed PermissionCode at the
    // guard, so it's harmless — but production must not crash).
    const result = await loader.load({ organizationId: "org-1", userId: "user-1" });
    expect(result).toHaveLength(1);
    expect(result[0]?.permissions.size).toBe(1);
  });

  it("passes organizationId and userId to $queryRaw as bound parameters (not string-concat)", async () => {
    const { loader, spy } = loaderWith([]);
    await loader.load({ organizationId: "org-1", userId: "user-1" });
    expect(spy).toHaveBeenCalledOnce();

    // Prisma.sql tagged values produce a Prisma.Sql instance whose
    // shape is structurally `{ strings: string[]; values: unknown[] }`.
    // We assert the parameter values are bound — NOT interpolated
    // into the SQL string. (Interpolation would be a SQL-injection
    // class of bug.)
    const callArg = spy.mock.calls[0]?.[0] as { strings?: string[]; values?: unknown[] };
    expect(Array.isArray(callArg.values)).toBe(true);
    expect(callArg.values).toContain("org-1");
    expect(callArg.values).toContain("user-1");
  });

  it("references quoted camelCase columns that actually exist (B-1 regression)", async () => {
    // The schema maps TABLE names to snake_case (@@map) but leaves
    // COLUMN names camelCase (no @map), so Postgres columns are
    // quoted identifiers: "userId", "roleId", "organizationId",
    // "siteId", "clinicId", "teamId", "permissionId". Unquoted
    // snake_case (ur.user_id) folds to lowercase and fails with
    // `column ... does not exist`. This guard catches that drift
    // without needing a live database.
    const { loader, spy } = loaderWith([]);
    await loader.load({ organizationId: "org-1", userId: "user-1" });
    const callArg = spy.mock.calls[0]?.[0] as { strings?: string[] };
    const sql = (callArg.strings ?? []).join("");

    // Correct, quoted camelCase identifiers are present.
    for (const col of [
      '"userId"',
      '"roleId"',
      '"organizationId"',
      '"siteId"',
      '"clinicId"',
      '"teamId"',
      '"permissionId"',
    ]) {
      expect(sql).toContain(col);
    }

    // The broken unquoted snake_case identifiers must NOT appear.
    for (const bad of [
      "user_id",
      "role_id",
      "organization_id",
      "site_id",
      "clinic_id",
      "team_id",
      "permission_id",
    ]) {
      expect(sql).not.toContain(bad);
    }
  });
});
