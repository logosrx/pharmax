// DB-truth integration tests for `audit_log`.
//
// audit_log is the most security-critical table in the schema:
//   - It is the SOC 2 evidence surface for CC7.2 / CC7.3 / CC8.1.
//   - Its rows are PHI-adjacent (the `metadata` JSONB CAN contain
//     references to PHI by design — though the writers redact).
//   - It is the only table for which BOTH application roles —
//     `pharmax_app` AND `pharmax_system` (the BYPASSRLS role) —
//     have UPDATE/DELETE REVOKEd. The immutability invariant must
//     hold universally; an audit row, once written, is permanent
//     until the row's tenant is shredded as a whole.
//
// These tests pin the DB-edge guarantees the rest of the platform
// builds on:
//
//   (1) RLS BLOCKS cross-tenant SELECT under `pharmax_app` with
//       the session GUC set to tenant A. An audit_log row written
//       under tenant B as `owner` (BYPASSRLS) must remain invisible
//       to a pharmax_app reader scoped to tenant A.
//
//   (2) RLS ALLOWS same-tenant SELECT — regression sentinel for (1).
//       If a misconfigured policy turns the table into a black
//       hole the same test catches it.
//
//   (3) RLS fail-closed: a pharmax_app connection with NO tenant
//       GUC set sees ZERO rows, even from organizations it would
//       otherwise be authorized for.
//
//   (4) REVOKE UPDATE actually denies UPDATE under BOTH
//       `pharmax_app` AND `pharmax_system`. The immutability
//       invariant is universal, enforced at the GRANT layer.
//
//   (5) REVOKE DELETE actually denies DELETE under both roles.
//
//   (6) UNIQUE (organizationId, seq) actually fires on a duplicate
//       insert. This is the per-tenant monotonicity guarantee
//       the chain advisory lock exists to protect.
//
//   (7) The `audit_chain_lock_key(uuid)` function exists, is
//       callable from `pharmax_app` and `pharmax_system`, and
//       returns a stable BIGINT for a given input — the chain
//       writer's serialization primitive.
//
//   (8) Chain linkage: a second sequential insert in the same
//       tenant correctly references the first row's entryHash as
//       its prevHash. The seed helper mirrors what the production
//       writer does atomically; this test pins that the schema
//       and the seed helper agree on the chain head invariant.
//
// Together these test that the security boundary around audit_log
// — RLS / GRANT / UNIQUE / chain primitive — actually fires at
// the database edge. A regression in any of them surfaces here
// before any production write hits the audit table.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSchemaReady,
  clearContext,
  connect,
  setSystemContext,
  setTenantContext,
  withClient,
  type DbRole,
} from "./lib/db.js";
import { cleanupTenant, insertAuditLogRow, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

const TEST_ACTION = "test.it.audit_log";
const TEST_RESOURCE_TYPE = "IntegrationTest";

describe("audit_log — DB-truth integration", () => {
  beforeAll(async () => {
    await assertSchemaReady();
  });

  describe("(1) RLS isolation — cross-tenant read is blocked", () => {
    let ownerClient: Client;
    let appClient: Client;
    let tenantA: SeededTenant;
    let tenantB: SeededTenant;
    let tenantBAuditCount: number;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      appClient = await connect("app");

      await setSystemContext(ownerClient);
      tenantA = await seedTenant(ownerClient);
      tenantB = await seedTenant(ownerClient);
      await insertAuditLogRow({
        client: ownerClient,
        organizationId: tenantB.organizationId,
        actorUserId: tenantB.adminUserId,
        action: TEST_ACTION,
        resourceType: TEST_RESOURCE_TYPE,
      });
      tenantBAuditCount = 1;
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenantA.organizationId);
      await cleanupTenant(ownerClient, tenantB.organizationId);
      await ownerClient.end();
      await appClient.end();
    });

    it("pharmax_app scoped to tenant A sees ZERO audit_log rows owned by tenant B", async () => {
      await setTenantContext(appClient, tenantA.organizationId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log WHERE "organizationId" = $1`,
        [tenantB.organizationId]
      );
      expect(result.rows[0]?.count).toBe("0");
    });

    it("pharmax_app scoped to tenant A sees ZERO audit_log rows even without WHERE clause filter (RLS is the filter)", async () => {
      await setTenantContext(appClient, tenantA.organizationId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log`
      );
      expect(result.rows[0]?.count).toBe("0");
    });

    it("pharmax_app scoped to tenant B sees the audit_log row we inserted (regression sentinel)", async () => {
      await setTenantContext(appClient, tenantB.organizationId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log`
      );
      expect(result.rows[0]?.count).toBe(String(tenantBAuditCount));
    });

    it("pharmax_app with NO tenant GUC sees ZERO audit_log rows (fail-closed when GUC is unset)", async () => {
      await clearContext(appClient);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log`
      );
      expect(result.rows[0]?.count).toBe("0");
    });
  });

  describe("(2) Immutability — REVOKE UPDATE/DELETE is universal", () => {
    let ownerClient: Client;
    let tenant: SeededTenant;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      await setSystemContext(ownerClient);
      tenant = await seedTenant(ownerClient);
      await insertAuditLogRow({
        client: ownerClient,
        organizationId: tenant.organizationId,
        actorUserId: tenant.adminUserId,
        action: TEST_ACTION,
        resourceType: TEST_RESOURCE_TYPE,
      });
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenant.organizationId);
      await ownerClient.end();
    });

    async function expectGrantDenied(
      role: DbRole,
      sql: string,
      params: ReadonlyArray<unknown>
    ): Promise<void> {
      await withClient(role, async (client) => {
        if (role === "app") {
          await setTenantContext(client, tenant.organizationId);
        } else if (role === "system") {
          await setSystemContext(client);
        }
        let error: unknown = undefined;
        try {
          await client.query(sql, [...params]);
        } catch (e) {
          error = e;
        }
        expect(error).toBeDefined();
        // 42501 = insufficient_privilege (Postgres GRANT denial).
        const code = (error as { code?: string }).code;
        expect(code, `expected 42501 insufficient_privilege; got ${String(code)}`).toBe("42501");
      });
    }

    it("pharmax_app cannot UPDATE audit_log (42501)", async () => {
      await expectGrantDenied(
        "app",
        `UPDATE audit_log SET action = 'tampered' WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
    });

    it("pharmax_app cannot DELETE FROM audit_log (42501)", async () => {
      await expectGrantDenied("app", `DELETE FROM audit_log WHERE "organizationId" = $1`, [
        tenant.organizationId,
      ]);
    });

    it("pharmax_system cannot UPDATE audit_log either — immutability is UNIVERSAL across both app roles", async () => {
      await expectGrantDenied(
        "system",
        `UPDATE audit_log SET action = 'tampered' WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
    });

    it("pharmax_system cannot DELETE FROM audit_log either", async () => {
      await expectGrantDenied("system", `DELETE FROM audit_log WHERE "organizationId" = $1`, [
        tenant.organizationId,
      ]);
    });
  });

  describe("(3) Chain primitives — UNIQUE(orgId, seq), advisory-lock fn, prevHash linkage", () => {
    let ownerClient: Client;
    let tenant: SeededTenant;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      await setSystemContext(ownerClient);
      tenant = await seedTenant(ownerClient);
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenant.organizationId);
      await ownerClient.end();
    });

    it("UNIQUE (organizationId, seq) fires on a duplicate seq insert (23505)", async () => {
      // Force a duplicate seq by inserting one row, then handcrafting
      // another with the same seq. In production the chain advisory
      // lock makes this impossible; the test verifies that even if
      // the lock were bypassed, the DB still refuses.
      const first = await insertAuditLogRow({
        client: ownerClient,
        organizationId: tenant.organizationId,
        actorUserId: tenant.adminUserId,
        action: TEST_ACTION,
        resourceType: TEST_RESOURCE_TYPE,
      });

      // Reuse `first.entryHash` for both prevHash and entryHash
      // of the colliding row — there is no UNIQUE on hash bytes,
      // so the unique_violation that fires is for (orgId, seq)
      // as intended.
      let error: unknown = undefined;
      try {
        await ownerClient.query(
          `INSERT INTO audit_log (
             id, "organizationId", "actorUserId", action, "resourceType",
             "prevHash", "entryHash", seq, "occurredAt"
           )
           VALUES (
             gen_random_uuid(), $1, $2, $3, $4,
             $5, $5, $6::bigint, now()
           )`,
          [
            tenant.organizationId,
            tenant.adminUserId,
            TEST_ACTION,
            TEST_RESOURCE_TYPE,
            first.entryHash,
            first.seq.toString(),
          ]
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      // 23505 = unique_violation.
      const code = (error as { code?: string }).code;
      expect(code, `expected 23505 unique_violation; got ${String(code)}`).toBe("23505");
      const constraint = (error as { constraint?: string }).constraint;
      // The UNIQUE constraint name follows Prisma's `@@unique` naming convention.
      expect(constraint).toBe("audit_log_organizationId_seq_key");
    });

    it("audit_chain_lock_key(uuid) returns a stable BIGINT (chain serialization primitive is GRANTed + callable)", async () => {
      // GRANTed to pharmax_app per the audit_chain migration; we
      // call from BOTH app roles to prove the GRANT is in place
      // and the function is callable from the runtime path the
      // chain writer takes in production.
      const sameKeyTwice = await withClient("app", async (client) => {
        await setTenantContext(client, tenant.organizationId);
        const a = await client.query<{ k: string }>(
          `SELECT audit_chain_lock_key($1::uuid)::text AS k`,
          [tenant.organizationId]
        );
        const b = await client.query<{ k: string }>(
          `SELECT audit_chain_lock_key($1::uuid)::text AS k`,
          [tenant.organizationId]
        );
        return { a: a.rows[0]?.k, b: b.rows[0]?.k };
      });
      expect(sameKeyTwice.a).toBeTypeOf("string");
      expect(sameKeyTwice.a).toBe(sameKeyTwice.b);

      // pharmax_system also has EXECUTE per the migration.
      const fromSystem = await withClient("system", async (client) => {
        await setSystemContext(client);
        const r = await client.query<{ k: string }>(
          `SELECT audit_chain_lock_key($1::uuid)::text AS k`,
          [tenant.organizationId]
        );
        return r.rows[0]?.k;
      });
      expect(fromSystem).toBe(sameKeyTwice.a);
    });

    it("two sequential inserts in the same tenant link prevHash[N+1] = entryHash[N] and seq is strictly monotonic", async () => {
      // The chain head advanced past seq=1 in the UNIQUE test above
      // (the duplicate-seq insert is rejected so the head is still
      // at the latest successful row). Insert a second row through
      // the seed helper and assert the schema-level linkage.
      const headRow = await ownerClient.query<{ latest_seq: string; latest_hash: Buffer }>(
        `SELECT "latestSeq"::text AS latest_seq, "latestHash" AS latest_hash
           FROM audit_chain_state WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
      const head = headRow.rows[0];
      expect(head).toBeDefined();
      const headSeqBefore = BigInt(head!.latest_seq);
      const headHashBefore = head!.latest_hash;

      const next = await insertAuditLogRow({
        client: ownerClient,
        organizationId: tenant.organizationId,
        actorUserId: tenant.adminUserId,
        action: TEST_ACTION,
        resourceType: TEST_RESOURCE_TYPE,
      });

      // (a) The new row's seq is exactly head.seq + 1.
      expect(next.seq).toBe(headSeqBefore + 1n);
      // (b) The new row's prevHash equals the prior head's entryHash.
      expect(next.prevHash).not.toBeNull();
      expect(Buffer.compare(next.prevHash!, headHashBefore)).toBe(0);

      // (c) The chain head row in audit_chain_state advanced to
      //     match. This is what the production writer maintains
      //     atomically inside the same tx as the audit_log insert.
      const newHeadRow = await ownerClient.query<{ latest_seq: string; latest_hash: Buffer }>(
        `SELECT "latestSeq"::text AS latest_seq, "latestHash" AS latest_hash
           FROM audit_chain_state WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
      const newHead = newHeadRow.rows[0];
      expect(newHead).toBeDefined();
      expect(BigInt(newHead!.latest_seq)).toBe(next.seq);
      expect(Buffer.compare(newHead!.latest_hash, next.entryHash)).toBe(0);
    });
  });
});
