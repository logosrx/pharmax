// RLS system-context sentinel — DB-truth integration (B-3 proof).
//
// `applySystemSessionGuc` (@pharmax/tenancy) sets
//   set_config('pharmax.system_context', 'on', ...)
// and every RLS policy must test for that exact value. Three Phase-5
// migrations originally tested `= 'true'` instead, which silently
// DENIED legitimate system-context reads/writes under the RLS-subject
// `pharmax_app` role (fail closed — availability bug, not a leak):
//
//   * notification_delivery
//   * access_review_snapshot
//   * report_run
//
// `20260629000000_fix_system_context_sentinel` recreates those
// policies with `= 'on'`. This suite pins the fix two ways:
//
//   (1) A catalog sweep over pg_policies: NO policy anywhere may
//       compare `pharmax.system_context` to the string 'true'. This
//       catches the same drift on ANY future table, not just the
//       three that regressed.
//   (2) Behavioral proof on each affected table: as `pharmax_app`
//       with system_context='on', a seeded row in another org is
//       visible; with no GUC, nothing is visible (fail closed).
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";

import { CommandStatus } from "@pharmax/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSchemaReady,
  clearContext,
  connect,
  setSystemContext,
  setTenantContext,
} from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

/** The tables whose policies regressed to the 'true' sentinel. */
const AFFECTED_TABLES = ["notification_delivery", "access_review_snapshot", "report_run"] as const;

describe("RLS system_context sentinel (B-3)", () => {
  let ownerClient: Client;
  let appClient: Client;
  let tenant: SeededTenant;
  let commandLogId: string;
  let notificationDeliveryId: string;
  let reportRunId: string;
  let accessReviewSnapshotId: string;

  beforeAll(async () => {
    await assertSchemaReady();
    ownerClient = await connect("owner");
    appClient = await connect("app");

    await setSystemContext(ownerClient);
    tenant = await seedTenant(ownerClient);

    // A command_log row to satisfy the report_run /
    // access_review_snapshot FK (same shape as lib/seed.ts).
    commandLogId = randomUUID();
    await ownerClient.query(
      `INSERT INTO command_log (
         id, "organizationId", "commandName", "actorUserId",
         "idempotencyKey", "requestPayload", status, "startedAt"
       )
       VALUES ($1, $2, 'RunReport', $3, $4, '{}'::jsonb, $5::"CommandStatus", now())`,
      [
        commandLogId,
        tenant.organizationId,
        tenant.adminUserId,
        `it-${randomUUID()}`,
        CommandStatus.SUCCEEDED,
      ]
    );

    notificationDeliveryId = randomUUID();
    await ownerClient.query(
      `INSERT INTO notification_delivery (
         id, "organizationId", template, "channelName", "recipientKind",
         "recipientAddress", "idempotencyKey", "updatedAt"
       )
       VALUES ($1, $2, 'it-template', 'email', 'OPERATOR', 'it@example.test', $3, now())`,
      [notificationDeliveryId, tenant.organizationId, `it-${randomUUID()}`]
    );

    reportRunId = randomUUID();
    await ownerClient.query(
      `INSERT INTO report_run (
         id, "organizationId", "reportId", "reportVersion", parameters,
         aggregates, "rowCount", "windowFrom", "windowTo", "generatedAt",
         "commandLogId"
       )
       VALUES ($1, $2, 'it.report', 1, '{}'::jsonb, '{}'::jsonb, 0, now(), now(), now(), $3)`,
      [reportRunId, tenant.organizationId, commandLogId]
    );

    accessReviewSnapshotId = randomUUID();
    await ownerClient.query(
      `INSERT INTO access_review_snapshot (
         id, "organizationId", "organizationSlug", "periodStart", "periodEnd",
         "generatedAt", "totalPrincipals", "elevatedPrincipalCount",
         "inactivePrincipalCount", "staleAssignmentCount",
         "cryptoShredCapableRoleCount", report, "digestSha256", "commandLogId"
       )
       VALUES ($1, $2, 'it-slug', now(), now(), now(), 0, 0, 0, 0, 0,
               '{}'::jsonb, 'it-digest', $3)`,
      [accessReviewSnapshotId, tenant.organizationId, commandLogId]
    );
  });

  afterAll(async () => {
    await setSystemContext(ownerClient);
    // Rows not covered by cleanupTenant's table list.
    await ownerClient.query(`DELETE FROM notification_delivery WHERE "organizationId" = $1`, [
      tenant.organizationId,
    ]);
    await ownerClient.query(`DELETE FROM report_run WHERE "organizationId" = $1`, [
      tenant.organizationId,
    ]);
    await ownerClient.query(`DELETE FROM access_review_snapshot WHERE "organizationId" = $1`, [
      tenant.organizationId,
    ]);
    await cleanupTenant(ownerClient, tenant.organizationId);
    await ownerClient.end();
    await appClient.end();
  });

  describe("(1) catalog sweep — no policy uses the 'true' sentinel", () => {
    it("every pg_policies entry referencing pharmax.system_context compares against 'on'", async () => {
      const result = await ownerClient.query<{
        tablename: string;
        policyname: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT tablename, policyname, qual, with_check
           FROM pg_policies
          WHERE qual LIKE '%pharmax.system_context%'
             OR with_check LIKE '%pharmax.system_context%'`
      );

      // Sanity: the RLS baseline means many tables carry this policy.
      expect(result.rows.length).toBeGreaterThan(0);

      const offenders = result.rows.filter((row) => {
        const qual = row.qual ?? "";
        const check = row.with_check ?? "";
        // Deparsed predicate looks like:
        //   current_setting('pharmax.system_context'::text, true) = 'on'::text
        // The quoted string 'true' only appears when the policy was
        // created with the broken sentinel. (The unquoted boolean arg
        // in current_setting(..., true) does NOT match this pattern.)
        return /=\s*'true'/.test(qual) || /=\s*'true'/.test(check);
      });

      expect(
        offenders.map((o) => `${o.tablename}.${o.policyname}`),
        "policies still comparing pharmax.system_context to 'true' — the GUC helper sets 'on', so these silently deny system-context access"
      ).toEqual([]);
    });

    it("every policy casting the org GUC to uuid guards it with NULLIF('')", async () => {
      // `applySystemSessionGuc` clears the org GUC to '' (empty
      // string), and Postgres does NOT short-circuit OR in policy
      // predicates. A bare `current_setting(...)::uuid` therefore
      // raises `invalid input syntax for type uuid: ""` on EVERY
      // query whenever the org GUC is empty — even with
      // system_context correctly set. The baseline's canonical
      // predicate wraps the cast in NULLIF(..., '') so an empty GUC
      // denies (fails closed) instead of erroring. This sweep pins
      // that invariant for all current and future tables.
      const result = await ownerClient.query<{
        tablename: string;
        policyname: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT tablename, policyname, qual, with_check
           FROM pg_policies
          WHERE qual LIKE '%pharmax.organization_id%'
             OR with_check LIKE '%pharmax.organization_id%'`
      );
      expect(result.rows.length).toBeGreaterThan(0);

      const offenders = result.rows.filter((row) => {
        for (const expr of [row.qual ?? "", row.with_check ?? ""]) {
          if (expr.includes("pharmax.organization_id") && !expr.includes("NULLIF")) {
            return true;
          }
        }
        return false;
      });

      expect(
        offenders.map((o) => `${o.tablename}.${o.policyname}`),
        "policies casting the org GUC to uuid without a NULLIF('') guard — these ERROR (not deny) when the GUC is empty"
      ).toEqual([]);
    });

    it("each previously-affected table has a tenant_isolation policy using the 'on' sentinel", async () => {
      for (const table of AFFECTED_TABLES) {
        const result = await ownerClient.query<{ qual: string | null }>(
          `SELECT qual FROM pg_policies
            WHERE tablename = $1 AND policyname = 'tenant_isolation'`,
          [table]
        );
        expect(result.rows, `missing tenant_isolation policy on ${table}`).toHaveLength(1);
        expect(result.rows[0]?.qual ?? "", `wrong sentinel on ${table}`).toMatch(/=\s*'on'/);
      }
    });
  });

  describe("(2) behavioral — pharmax_app honors system_context='on' on the affected tables", () => {
    it("fail closed: with NO GUC, none of the seeded rows are visible", async () => {
      await clearContext(appClient);
      for (const table of AFFECTED_TABLES) {
        const result = await appClient.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${table}" WHERE "organizationId" = $1`,
          [tenant.organizationId]
        );
        expect(result.rows[0]?.count, `${table} should be invisible without a GUC`).toBe("0");
      }
    });

    it("system_context='on': cross-org reads are permitted (the B-3 regression path)", async () => {
      // Before the fix migration, the 'true' sentinel made this exact
      // pattern return zero rows under pharmax_app — breaking e.g.
      // the Resend webhook's cross-tenant notification_delivery
      // resolution and web-side report_run system reads.
      await setSystemContext(appClient);
      for (const table of AFFECTED_TABLES) {
        const result = await appClient.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${table}" WHERE "organizationId" = $1`,
          [tenant.organizationId]
        );
        expect(
          Number(result.rows[0]?.count),
          `${table} must be readable in system context under pharmax_app`
        ).toBeGreaterThanOrEqual(1);
      }
    });

    it("org GUC: tenant-scoped reads also see the rows (unchanged predicate)", async () => {
      await setTenantContext(appClient, tenant.organizationId);
      for (const table of AFFECTED_TABLES) {
        const result = await appClient.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${table}" WHERE "organizationId" = $1`,
          [tenant.organizationId]
        );
        expect(
          Number(result.rows[0]?.count),
          `${table} must be readable in tenant context`
        ).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
