// PrismaPermissionLoader — live-database integration (B-1 proof).
//
// The unit tests in `packages/rbac/src/prisma-permission-loader.test.ts`
// mock `$queryRaw`, so they can never catch a column-identifier drift
// against the real schema. That is exactly how B-1 shipped: the
// loader's raw SQL referenced unquoted snake_case columns
// (`ur.user_id`, `ur.site_id`, ...) while the actual Postgres columns
// are quoted camelCase (`"userId"`, `"siteId"`, ...) — Postgres folds
// unquoted identifiers to lowercase, so EVERY permission load raised
// `column ... does not exist` and RBAC denied everything (fail
// closed: an availability bug, not an escalation).
//
// This suite runs the PRODUCTION loader class against the live
// schema, exactly as `apps/web/src/server/bootstrap.ts` and
// `apps/worker/src/main.ts` wire it. If the SQL and the schema ever
// drift again, this goes red before production does.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@pharmax/database";
import { PrismaPermissionLoader } from "@pharmax/rbac";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSchemaReady, connect, setSystemContext } from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

function resolveDatabaseUrl(): string {
  const intg = process.env["INTEGRATION_DATABASE_URL"];
  if (typeof intg === "string" && intg.length > 0) return intg;
  const dev = process.env["DATABASE_URL"];
  if (typeof dev === "string" && dev.length > 0) return dev;
  throw new Error("No INTEGRATION_DATABASE_URL or DATABASE_URL set.");
}

describe("PrismaPermissionLoader — live schema (B-1)", () => {
  let ownerClient: Client;
  // Dedicated Prisma client pinned to the SAME database as the pg
  // harness (datasourceUrl overrides the schema's env() default, so
  // INTEGRATION_DATABASE_URL keeps both halves consistent).
  let prismaClient: PrismaClient;
  let loader: PrismaPermissionLoader;
  let tenant: SeededTenant;
  let otherTenant: SeededTenant;

  const tag = randomUUID().slice(0, 8);
  const roleId = randomUUID();
  const userRoleId = randomUUID();
  const permissionAId = randomUUID();
  const permissionBId = randomUUID();
  // Synthetic, namespaced codes so we never collide with (or delete)
  // the real seeded vocabulary. The loader passes unknown codes
  // through verbatim (registry filtering happens at the guard).
  const permissionACode = `it.loader.${tag}.read`;
  const permissionBCode = `it.loader.${tag}.write`;

  beforeAll(async () => {
    await assertSchemaReady();
    ownerClient = await connect("owner");
    await setSystemContext(ownerClient);

    tenant = await seedTenant(ownerClient);
    otherTenant = await seedTenant(ownerClient);

    // RBAC fixture: permission x2 → role → role_permission x2 →
    // user_role granted to tenant's admin, scoped to the seeded SITE
    // (exercises the "siteId" column that the broken SQL referenced
    // as site_id).
    await ownerClient.query(
      `INSERT INTO permission (id, code, description, "isSystem", "createdAt")
       VALUES ($1, $2, 'IT loader perm A', false, now()),
              ($3, $4, 'IT loader perm B', false, now())`,
      [permissionAId, permissionACode, permissionBId, permissionBCode]
    );
    await ownerClient.query(
      `INSERT INTO role (
         id, "organizationId", code, name, scope, "isSystem", "createdAt", "updatedAt"
       )
       VALUES ($1, $2, $3, 'IT Loader Role', 'ORGANIZATION'::"RoleScope", false, now(), now())`,
      [roleId, tenant.organizationId, `IT_LOADER_${tag}`]
    );
    await ownerClient.query(
      `INSERT INTO role_permission (id, "roleId", "permissionId", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, now()),
              (gen_random_uuid(), $1, $3, now())`,
      [roleId, permissionAId, permissionBId]
    );
    await ownerClient.query(
      `INSERT INTO user_role (
         id, "userId", "roleId", "organizationId", "siteId", "createdAt"
       )
       VALUES ($1, $2, $3, $4, $5, now())`,
      [userRoleId, tenant.adminUserId, roleId, tenant.organizationId, tenant.siteId]
    );

    // Prisma 7: pin the client to the same DB as the pg harness via a
    // dedicated driver adapter (the v6 `datasourceUrl` override is gone).
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }),
    });
    loader = new PrismaPermissionLoader(prismaClient);
  });

  afterAll(async () => {
    await prismaClient.$disconnect();
    await setSystemContext(ownerClient);
    // RBAC rows are not covered by cleanupTenant — leaf-first.
    await ownerClient.query(`DELETE FROM user_role WHERE id = $1`, [userRoleId]);
    await ownerClient.query(`DELETE FROM role_permission WHERE "roleId" = $1`, [roleId]);
    await ownerClient.query(`DELETE FROM role WHERE id = $1`, [roleId]);
    await ownerClient.query(`DELETE FROM permission WHERE id IN ($1, $2)`, [
      permissionAId,
      permissionBId,
    ]);
    await cleanupTenant(ownerClient, tenant.organizationId);
    await cleanupTenant(ownerClient, otherTenant.organizationId);
    await ownerClient.end();
  });

  it("executes the production raw SQL without a column-resolution error (the B-1 regression)", async () => {
    // Before the fix this rejected with Prisma's raw-query error
    // wrapping `column ur.user_id does not exist` (42703).
    await expect(
      loader.load({ organizationId: tenant.organizationId, userId: tenant.adminUserId })
    ).resolves.toBeDefined();
  });

  it("returns the seeded grant with role scope, site scope, and both permission codes", async () => {
    const grants = await loader.load({
      organizationId: tenant.organizationId,
      userId: tenant.adminUserId,
    });

    expect(grants).toHaveLength(1);
    const grant = grants[0];
    expect(grant?.roleScope).toBe("ORGANIZATION");
    expect(grant?.grantScope).toEqual({
      siteId: tenant.siteId,
      clinicId: null,
      teamId: null,
    });
    const codes = Array.from(grant?.permissions ?? []).sort();
    expect(codes).toEqual([permissionACode, permissionBCode].sort());
  });

  it("is org-isolated: the same user id under another organization has no grants", async () => {
    const grants = await loader.load({
      organizationId: otherTenant.organizationId,
      userId: tenant.adminUserId,
    });
    expect(grants).toEqual([]);
  });

  it("returns an empty array for a user with no grants (deny-by-default input)", async () => {
    const grants = await loader.load({
      organizationId: otherTenant.organizationId,
      userId: otherTenant.adminUserId,
    });
    expect(grants).toEqual([]);
  });
});
