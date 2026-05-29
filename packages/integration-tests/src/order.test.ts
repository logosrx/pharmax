// DB-truth integration tests for `order`.
//
// `order` is the central workflow row — every command in the
// pharmacy pipeline mutates it. Two database-edge guarantees this
// suite pins:
//
//   - RLS BLOCKS cross-tenant SELECT. This is the same isolation
//     guarantee the verification_record + audit_log suites assert
//     for their tables; we re-prove it here because `order` is the
//     row most commonly leaked by a missed `organizationId` clause
//     in a hand-written repository.
//
//   - The COMPARE-AND-SWAP (`UPDATE ... WHERE id = $1 AND version =
//     $expected`) pattern that every command handler uses to fence
//     concurrent transitions actually serializes under Postgres'
//     READ COMMITTED isolation level. Two concurrent transactions
//     that race to advance the same order from version=1 to
//     version=2 must produce: ONE row updated, ONE zero-row no-op,
//     final version=2 (not 3).
//
// The CAS test is the load-bearing assertion for ADR-0007's
// "every workflow transition must lock the order row" rule. If a
// schema change ever drops the version column or relaxes the
// UPDATE WHERE pattern in production code, this test still pins
// the DB-level guarantee that the original CAS pattern works.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSchemaReady,
  clearContext,
  connect,
  setSystemContext,
  setTenantContext,
} from "./lib/db.js";
import { cleanupTenant, seedOrderChain, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

describe("order — DB-truth integration", () => {
  beforeAll(async () => {
    await assertSchemaReady();
  });

  describe("(1) RLS isolation — cross-tenant read is blocked", () => {
    let ownerClient: Client;
    let appClient: Client;
    let tenantA: SeededTenant;
    let tenantB: SeededTenant;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      appClient = await connect("app");

      await setSystemContext(ownerClient);
      tenantA = await seedTenant(ownerClient);
      tenantB = await seedTenant(ownerClient);
      // Tenant B gets an order; tenant A is the attacker.
      await seedOrderChain(ownerClient, tenantB);
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenantA.organizationId);
      await cleanupTenant(ownerClient, tenantB.organizationId);
      await ownerClient.end();
      await appClient.end();
    });

    it("pharmax_app scoped to tenant A sees ZERO orders owned by tenant B", async () => {
      await setTenantContext(appClient, tenantA.organizationId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "order" WHERE "organizationId" = $1`,
        [tenantB.organizationId]
      );
      expect(result.rows[0]?.count).toBe("0");
    });

    it("pharmax_app scoped to tenant B sees its own order (regression sentinel)", async () => {
      await setTenantContext(appClient, tenantB.organizationId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "order"`
      );
      expect(result.rows[0]?.count).toBe("1");
    });

    it("pharmax_app with NO tenant GUC sees ZERO orders (fail-closed)", async () => {
      await clearContext(appClient);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "order"`
      );
      expect(result.rows[0]?.count).toBe("0");
    });
  });

  describe("(2) CAS row-lock — concurrent version-fenced UPDATEs serialize", () => {
    let ownerClient: Client;
    let tenant: SeededTenant;
    let orderId: string;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      await setSystemContext(ownerClient);
      tenant = await seedTenant(ownerClient);
      const chain = await seedOrderChain(ownerClient, tenant);
      orderId = chain.orderId;

      // Confirm the seed put us at version=1 — the CAS race below
      // expects this as the starting state.
      const seedCheck = await ownerClient.query<{ version: number }>(
        `SELECT version FROM "order" WHERE id = $1`,
        [orderId]
      );
      if (seedCheck.rows[0]?.version !== 1) {
        throw new Error(
          `Test setup: expected seeded order at version=1; got ${String(seedCheck.rows[0]?.version)}`
        );
      }
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenant.organizationId);
      await ownerClient.end();
    });

    it("two concurrent UPDATE ... WHERE version=1 collide — exactly one succeeds, the other no-ops, final version=2", async () => {
      // Two independent connections, each in its own tx, both
      // pharmax_app + scoped to the same tenant — the EXACT shape
      // a real command handler takes.
      const txA = await connect("app");
      const txB = await connect("app");
      try {
        await setTenantContext(txA, tenant.organizationId);
        await setTenantContext(txB, tenant.organizationId);

        await txA.query(`BEGIN`);
        await txB.query(`BEGIN`);

        // T1 fires its CAS UPDATE first; it acquires the row
        // lock immediately and reports 1 row affected.
        const resA = await txA.query(
          `UPDATE "order" SET version = 2, "updatedAt" = now()
             WHERE id = $1 AND version = 1`,
          [orderId]
        );
        expect(resA.rowCount).toBe(1);

        // T2 fires its CAS UPDATE while T1 still holds the row
        // lock. The UPDATE blocks until T1 commits or rolls back.
        // We kick it off WITHOUT awaiting, then commit T1.
        const txBUpdate = txB.query(
          `UPDATE "order" SET version = 2, "updatedAt" = now()
             WHERE id = $1 AND version = 1`,
          [orderId]
        );

        // Small sleep to give txB's UPDATE a chance to enter the
        // server's lock-wait state. Without this the assertion
        // that txB was actually BLOCKED (vs. just slow) is less
        // confident. The sleep is generous so flaky CI hosts still
        // pass.
        await sleep(100);

        // Commit T1 — this releases the row lock and lets T2's
        // UPDATE proceed.
        await txA.query(`COMMIT`);

        const resB = await txBUpdate;
        // Under READ COMMITTED, T2's WHERE clause is re-evaluated
        // against the post-T1 tuple; version is now 2, not 1, so
        // the WHERE fails and the UPDATE affects 0 rows. This is
        // the load-bearing CAS guarantee.
        expect(resB.rowCount).toBe(0);

        await txB.query(`COMMIT`);

        // The final row should be at version=2, NOT version=3.
        // A naive "increment by 1" without CAS would race to 3.
        const finalRow = await ownerClient.query<{ version: number }>(
          `SELECT version FROM "order" WHERE id = $1`,
          [orderId]
        );
        expect(finalRow.rows[0]?.version).toBe(2);
      } finally {
        // Make sure neither tx is left dangling if an assertion
        // fails mid-test.
        await txA.query(`ROLLBACK`).catch(() => undefined);
        await txB.query(`ROLLBACK`).catch(() => undefined);
        await txA.end().catch(() => undefined);
        await txB.end().catch(() => undefined);
      }
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
