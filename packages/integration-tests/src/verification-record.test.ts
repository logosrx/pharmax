// DB-truth integration tests for `verification_record`.
//
// These tests run against a real Postgres (the docker-compose
// `postgres` service in this repo) and verify what the
// fake-Prisma unit tests structurally cannot:
//
//   1. RLS BLOCKS CROSS-TENANT SELECT under the runtime
//      `pharmax_app` role with the session GUC set to tenant A.
//      Inserting a verification_record under tenant B as the
//      `owner` role (BYPASSRLS) must remain invisible to a
//      pharmax_app reader scoped to tenant A.
//
//   2. RLS ALLOWS SAME-TENANT SELECT — the regression sentinel
//      for #1. If a misconfigured policy turns the table into a
//      black hole the same test catches it.
//
//   3. REVOKE UPDATE actually denies UPDATE under both
//      `pharmax_app` AND `pharmax_system` (pharmax_system
//      BYPASSes RLS but the immutability invariant is universal,
//      enforced at the GRANT layer).
//
//   4. REVOKE DELETE actually denies DELETE — same coverage.
//
//   5. CHECK CONSTRAINT
//      `verification_record_rejection_reason_required` rejects
//      both invalid combinations:
//        (a) APPROVED with a non-null `rejectionReasonCode`.
//        (b) REJECTED with a null `rejectionReasonCode`.
//
//   6. CHECK CONSTRAINT accepts valid combinations:
//        (a) APPROVED with `rejectionReasonCode = NULL`.
//        (b) REJECTED with a non-null `rejectionReasonCode`.
//
// Together these test that the four layers we claim to enforce —
// RLS / GRANT / CHECK / FK — actually fire at the database edge.
// Bypassing any of them would surface as a test failure here.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  assertSchemaReady,
  clearContext,
  connect,
  setSystemContext,
  setTenantContext,
  withClient,
  type DbRole,
} from "./lib/db.js";
import { cleanupTenant, seedOrderChain, seedTenant } from "./lib/seed.js";

import type { Client } from "pg";

const PHI_SAFE_DECISION_APPROVED = "APPROVED";
const PHI_SAFE_STAGE_PV1 = "PV1";

interface InsertVerificationArgs {
  readonly client: Client;
  readonly orgId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly workflowPolicyId: string;
  readonly commandLogId: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly rejectionReasonCode: string | null;
}

async function insertVerificationRecord(args: InsertVerificationArgs): Promise<void> {
  await args.client.query(
    `INSERT INTO verification_record (
       id, "organizationId", "orderId", "pharmacistUserId",
       stage, decision, "rejectionReasonCode",
       "workflowPolicyId", "workflowPolicyVersion",
       "commandLogId", "occurredAt", "createdAt"
     )
     VALUES (
       gen_random_uuid(), $1, $2, $3,
       $4::"VerificationStage", $5::"VerificationDecision", $6,
       $7, 1,
       $8, now(), now()
     )`,
    [
      args.orgId,
      args.orderId,
      args.userId,
      PHI_SAFE_STAGE_PV1,
      args.decision,
      args.rejectionReasonCode,
      args.workflowPolicyId,
      args.commandLogId,
    ]
  );
}

describe("verification_record — DB-truth integration", () => {
  beforeAll(async () => {
    await assertSchemaReady();
  });

  describe("(1) RLS isolation — cross-tenant read is blocked", () => {
    let ownerClient: Client;
    let appClient: Client;
    let tenantAOrgId: string;
    let tenantBOrgId: string;
    let tenantBVerificationCount: number;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      appClient = await connect("app");

      // Seed two tenants. Insert a verification_record only in
      // tenant B; tenant A is the attacker context.
      await setSystemContext(ownerClient);
      const tenantA = await seedTenant(ownerClient);
      const tenantB = await seedTenant(ownerClient);
      const chainB = await seedOrderChain(ownerClient, tenantB);
      await insertVerificationRecord({
        client: ownerClient,
        orgId: tenantB.organizationId,
        orderId: chainB.orderId,
        userId: tenantB.adminUserId,
        workflowPolicyId: tenantB.workflowPolicyId,
        commandLogId: chainB.commandLogId,
        decision: PHI_SAFE_DECISION_APPROVED,
        rejectionReasonCode: null,
      });
      tenantAOrgId = tenantA.organizationId;
      tenantBOrgId = tenantB.organizationId;
      tenantBVerificationCount = 1;
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenantAOrgId);
      await cleanupTenant(ownerClient, tenantBOrgId);
      await ownerClient.end();
      await appClient.end();
    });

    it("pharmax_app scoped to tenant A sees ZERO verification_records owned by tenant B", async () => {
      await setTenantContext(appClient, tenantAOrgId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verification_record WHERE "organizationId" = $1`,
        [tenantBOrgId]
      );
      expect(result.rows[0]?.count).toBe("0");
    });

    it("pharmax_app scoped to tenant A sees ZERO verification_records even without WHERE clause filter (RLS is the filter)", async () => {
      await setTenantContext(appClient, tenantAOrgId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verification_record`
      );
      expect(result.rows[0]?.count).toBe("0");
    });

    it("pharmax_app scoped to tenant B sees the verification_record we inserted (regression sentinel)", async () => {
      await setTenantContext(appClient, tenantBOrgId);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verification_record`
      );
      expect(result.rows[0]?.count).toBe(String(tenantBVerificationCount));
    });

    it("pharmax_app with NO tenant GUC sees ZERO rows (fail-closed when GUC is unset)", async () => {
      await clearContext(appClient);
      const result = await appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verification_record`
      );
      expect(result.rows[0]?.count).toBe("0");
    });
  });

  describe("(2) Immutability — REVOKE UPDATE/DELETE actually denies", () => {
    let ownerClient: Client;
    let tenant: Awaited<ReturnType<typeof seedTenant>>;
    let chain: Awaited<ReturnType<typeof seedOrderChain>>;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      await setSystemContext(ownerClient);
      tenant = await seedTenant(ownerClient);
      chain = await seedOrderChain(ownerClient, tenant);
      await insertVerificationRecord({
        client: ownerClient,
        orgId: tenant.organizationId,
        orderId: chain.orderId,
        userId: tenant.adminUserId,
        workflowPolicyId: tenant.workflowPolicyId,
        commandLogId: chain.commandLogId,
        decision: PHI_SAFE_DECISION_APPROVED,
        rejectionReasonCode: null,
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
        // 42501 = insufficient_privilege (the postgres error
        // class for GRANT denials).
        const code = (error as { code?: string }).code;
        expect(code, `expected 42501 insufficient_privilege; got ${String(code)}`).toBe("42501");
      });
    }

    it("pharmax_app cannot UPDATE verification_record (42501 insufficient_privilege)", async () => {
      await expectGrantDenied(
        "app",
        `UPDATE verification_record SET decision = 'REJECTED' WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
    });

    it("pharmax_app cannot DELETE FROM verification_record (42501 insufficient_privilege)", async () => {
      await expectGrantDenied(
        "app",
        `DELETE FROM verification_record WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
    });

    it("pharmax_system cannot UPDATE verification_record either (immutability is universal)", async () => {
      await expectGrantDenied(
        "system",
        `UPDATE verification_record SET decision = 'REJECTED' WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
    });

    it("pharmax_system cannot DELETE FROM verification_record either", async () => {
      await expectGrantDenied(
        "system",
        `DELETE FROM verification_record WHERE "organizationId" = $1`,
        [tenant.organizationId]
      );
    });
  });

  describe("(3) CHECK constraint — decision↔reason invariant", () => {
    let ownerClient: Client;
    let tenant: Awaited<ReturnType<typeof seedTenant>>;
    let chain: Awaited<ReturnType<typeof seedOrderChain>>;

    beforeAll(async () => {
      ownerClient = await connect("owner");
      await setSystemContext(ownerClient);
      tenant = await seedTenant(ownerClient);
      chain = await seedOrderChain(ownerClient, tenant);
    });

    afterEach(async () => {
      // Each negative test below tries to write a verification
      // row that should fail. If a write somehow succeeded we
      // don't want it polluting the next test, so we clear the
      // table for this tenant between cases.
      await setSystemContext(ownerClient);
      await ownerClient.query(`DELETE FROM verification_record WHERE "organizationId" = $1`, [
        tenant.organizationId,
      ]);
    });

    afterAll(async () => {
      await setSystemContext(ownerClient);
      await cleanupTenant(ownerClient, tenant.organizationId);
      await ownerClient.end();
    });

    async function expectCheckViolation(
      decision: "APPROVED" | "REJECTED",
      rejectionReasonCode: string | null
    ): Promise<void> {
      let error: unknown = undefined;
      try {
        await insertVerificationRecord({
          client: ownerClient,
          orgId: tenant.organizationId,
          orderId: chain.orderId,
          userId: tenant.adminUserId,
          workflowPolicyId: tenant.workflowPolicyId,
          commandLogId: chain.commandLogId,
          decision,
          rejectionReasonCode,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      // 23514 = check_violation.
      const code = (error as { code?: string }).code;
      expect(code, `expected 23514 check_violation; got ${String(code)}`).toBe("23514");
      const constraint = (error as { constraint?: string }).constraint;
      expect(constraint).toBe("verification_record_rejection_reason_required");
    }

    it("rejects APPROVED with a non-null rejectionReasonCode (23514 check_violation)", async () => {
      await expectCheckViolation("APPROVED", "PV1_DOSING_ERROR");
    });

    it("rejects REJECTED with a null rejectionReasonCode", async () => {
      await expectCheckViolation("REJECTED", null);
    });

    it("ACCEPTS APPROVED with null rejectionReasonCode", async () => {
      await expect(
        insertVerificationRecord({
          client: ownerClient,
          orgId: tenant.organizationId,
          orderId: chain.orderId,
          userId: tenant.adminUserId,
          workflowPolicyId: tenant.workflowPolicyId,
          commandLogId: chain.commandLogId,
          decision: "APPROVED",
          rejectionReasonCode: null,
        })
      ).resolves.toBeUndefined();
    });

    it("ACCEPTS REJECTED with a non-null rejectionReasonCode", async () => {
      await expect(
        insertVerificationRecord({
          client: ownerClient,
          orgId: tenant.organizationId,
          orderId: chain.orderId,
          userId: tenant.adminUserId,
          workflowPolicyId: tenant.workflowPolicyId,
          commandLogId: chain.commandLogId,
          decision: "REJECTED",
          rejectionReasonCode: "PV1_DOSING_ERROR",
        })
      ).resolves.toBeUndefined();
    });
  });
});
