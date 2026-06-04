// RLS role-cutover invariants — DB-truth integration.
//
// These tests pin the load-bearing guarantees the `pharmax_app`
// cutover relies on (see docs/RUNBOOK.md "RLS role cutover"). They run
// as the `pharmax_app` role — the RLS-SUBJECT runtime role the web tier
// connects as in production — and assert that the GUC patterns the
// application code now sets actually permit / deny the right rows.
//
// The application equivalents:
//   - `readInOrgScope` / `readInTenantContext` set the org GUC before a
//     tenant read. Validated by §(2): with the org GUC, a tenant table
//     read is scoped to that org; with none, it fails closed.
//   - `readInSystemContext` + the migrated auth/webhook/worker resolvers
//     set the `system_context` GUC before a CROSS-org read (e.g.
//     resolve-tenancy's clerkUserId lookup). Validated by §(3): with
//     `system_context='on'`, the same role reads across orgs; without
//     it, the read fails closed.
//
// If a future change connects the web runtime as `pharmax_app` WITHOUT
// the GUC plumbing, these tests go red — the cutover's safety net.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  assertSchemaReady,
  clearContext,
  connect,
  setSystemContext,
  setTenantContext,
} from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

describe("RLS role cutover — pharmax_app invariants", () => {
  let ownerClient: Client;
  let appClient: Client;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  // Clerk identity stamped on tenant A's seeded admin user, so the
  // cross-org `clerkUserId` lookup (resolve-tenancy's shape) has a
  // deterministic target.
  const clerkUserId = `clerk_it_${randomUUID().slice(0, 12)}`;

  beforeAll(async () => {
    await assertSchemaReady();
    ownerClient = await connect("owner");
    appClient = await connect("app");

    await setSystemContext(ownerClient);
    tenantA = await seedTenant(ownerClient);
    tenantB = await seedTenant(ownerClient);

    // Stamp the Clerk identity on tenant A's admin user (mirrors a
    // linked operator). The owner connection bypasses RLS for setup.
    await ownerClient.query(`UPDATE "user" SET "clerkUserId" = $1 WHERE id = $2`, [
      clerkUserId,
      tenantA.adminUserId,
    ]);
  });

  afterAll(async () => {
    await setSystemContext(ownerClient);
    await cleanupTenant(ownerClient, tenantA.organizationId);
    await cleanupTenant(ownerClient, tenantB.organizationId);
    await ownerClient.end();
    await appClient.end();
  });

  describe("(1) fail-closed: no GUC means zero rows", () => {
    it("pharmax_app with NO context cannot read any user (RLS denies)", async () => {
      await clearContext(appClient);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "user" WHERE "clerkUserId" = $1`,
        [clerkUserId]
      );
      // Without the org or system_context GUC the policy predicate is
      // false for every row — exactly what would break a non-GUC read
      // helper under pharmax_app.
      expect(result.rows[0]?.count).toBe("0");
    });
  });

  describe("(2) org GUC: tenant reads are scoped to the active org", () => {
    it("scoped to tenant A, sees A's users and NONE of B's", async () => {
      await setTenantContext(appClient, tenantA.organizationId);

      const ownOrg = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "user" WHERE "organizationId" = $1`,
        [tenantA.organizationId]
      );
      expect(Number(ownOrg.rows[0]?.count)).toBeGreaterThanOrEqual(1);

      const otherOrg = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "user" WHERE "organizationId" = $1`,
        [tenantB.organizationId]
      );
      expect(otherOrg.rows[0]?.count).toBe("0");
    });
  });

  describe("(3) system_context GUC: cross-org system reads are permitted", () => {
    it("with system_context='on', resolves a user by clerkUserId across orgs", async () => {
      // This is the resolve-tenancy / Clerk-webhook / worker-resolver
      // shape: a tenant-less external id resolved to its row before any
      // org frame exists. Under pharmax_app this ONLY works because the
      // migrated code sets `system_context` on the connection.
      await setSystemContext(appClient);
      const result = await appClient.query<{ id: string; organizationId: string }>(
        `SELECT id, "organizationId" FROM "user" WHERE "clerkUserId" = $1`,
        [clerkUserId]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.id).toBe(tenantA.adminUserId);
      expect(result.rows[0]?.organizationId).toBe(tenantA.organizationId);
    });

    it("with system_context='on', can also read tenant B's users (genuinely cross-org)", async () => {
      await setSystemContext(appClient);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "user" WHERE "organizationId" = $1`,
        [tenantB.organizationId]
      );
      expect(Number(result.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });
  });
});
