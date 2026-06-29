// Exhaustive cross-tenant isolation — DB-truth integration.
//
// This suite is the "tenant leakage is impossible to merge" gate.
// EONPRO's mistake was relying on an application-layer wrapper to
// inject the tenant id: one missed wrapper, one raw query, or one
// new table added six months later without isolation, and PHI
// crosses tenants. We make the DATABASE the backstop and prove it
// two ways, driven by the application's OWN source of truth (the
// `TENANT_SCOPED_MODELS` registry the Prisma extension consults).
//
//   (1) STRUCTURAL, exhaustive over the registry. For every model
//       the app treats as tenant-scoped, the backing table MUST
//       have RLS enabled, FORCEd (so even the table owner is
//       subject to it), and carry an org-isolation policy. A model
//       added to the registry without a matching RLS migration —
//       the classic "new table, no RLS" regression — fails here.
//       This complements scripts/check-migration-rls.ts (which
//       gates at the migration-file layer) by pinning the running
//       DB against the registry the runtime actually uses.
//
//   (2) BEHAVIORAL, two-tenant. Seed tenant A and tenant B, then as
//       the RLS-subject `pharmax_app` role under tenant A's GUC,
//       assert that NONE of tenant B's rows are visible across the
//       seeded tables, while tenant A's own rows ARE. This is the
//       literal "query as Tenant A returns zero Tenant B rows"
//       proof, exercised against real role + GUC machinery rather
//       than the application wrapper.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TENANT_SCOPED_MODELS as REGISTRY } from "@pharmax/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSchemaReady, connect, setSystemContext, setTenantContext } from "./lib/db.js";
import {
  cleanupTenant,
  insertAuditLogRow,
  seedOrderChain,
  seedTenant,
  type SeededTenant,
} from "./lib/seed.js";

import type { Client } from "pg";

// Prisma 7 removed the runtime `Prisma.dmmf` value, so load the
// model→table (`dbName`) mapping the `@@map` directives produce from
// the schema's DMMF via `@prisma/internals.getDMMF`. This keeps the
// lookup derived from the schema (never a hand-maintained snake_case
// table that could drift). `@prisma/internals` is CommonJS; reach its
// named export through `createRequire` for ESM interop under vitest.
// Populated in `beforeAll` since `getDMMF` is async.
const requireCjs = createRequire(import.meta.url);
let MODEL_TO_TABLE: ReadonlyMap<string, string> = new Map();

async function loadModelToTable(): Promise<ReadonlyMap<string, string>> {
  const schemaPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
    "prisma/schema.prisma"
  );
  const { getDMMF } = requireCjs("@prisma/internals") as {
    getDMMF: (options: { datamodel: string }) => Promise<{
      datamodel: { models: ReadonlyArray<{ name: string; dbName: string | null }> };
    }>;
  };
  const dmmf = await getDMMF({ datamodel: readFileSync(schemaPath, "utf8") });
  return new Map(dmmf.datamodel.models.map((m) => [m.name, m.dbName ?? m.name]));
}

/**
 * Tables the seeder populates for BOTH tenants, with the column the
 * tenant predicate keys on. The Organization row itself keys on
 * `id`; every other seeded table carries `organizationId`. Each is
 * quoted for the reserved-word tables (`order`, `user`).
 */
const SEEDED_BEHAVIORAL_TABLES: ReadonlyArray<{ table: string; orgColumn: string }> = [
  { table: "organization", orgColumn: "id" },
  { table: "workflow_policy", orgColumn: "organizationId" },
  { table: "pharmacy_site", orgColumn: "organizationId" },
  { table: "clinic", orgColumn: "organizationId" },
  { table: "bucket", orgColumn: "organizationId" },
  { table: "user", orgColumn: "organizationId" },
  { table: "patient", orgColumn: "organizationId" },
  { table: "order", orgColumn: "organizationId" },
  { table: "command_log", orgColumn: "organizationId" },
  { table: "audit_log", orgColumn: "organizationId" },
  { table: "audit_chain_state", orgColumn: "organizationId" },
];

async function countWhereOrg(
  client: Client,
  table: string,
  orgColumn: string,
  orgId: string
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${table}" WHERE "${orgColumn}" = $1`,
    [orgId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("cross-tenant isolation (RLS backstop)", () => {
  let ownerClient: Client;
  let appClient: Client;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    MODEL_TO_TABLE = await loadModelToTable();
    await assertSchemaReady();
    ownerClient = await connect("owner");
    appClient = await connect("app");

    await setSystemContext(ownerClient);
    tenantA = await seedTenant(ownerClient);
    tenantB = await seedTenant(ownerClient);

    // Populate the PHI domain chain (patient → order → command_log)
    // and one audit_log + audit_chain_state row for BOTH tenants, so
    // the behavioral sweep has real rows on each side to prove the
    // boundary against.
    await seedOrderChain(ownerClient, tenantA);
    await seedOrderChain(ownerClient, tenantB);
    await insertAuditLogRow({
      client: ownerClient,
      organizationId: tenantA.organizationId,
      actorUserId: tenantA.adminUserId,
      action: "it.cross_tenant.seed",
      resourceType: "Order",
    });
    await insertAuditLogRow({
      client: ownerClient,
      organizationId: tenantB.organizationId,
      actorUserId: tenantB.adminUserId,
      action: "it.cross_tenant.seed",
      resourceType: "Order",
    });
  });

  afterAll(async () => {
    await setSystemContext(ownerClient);
    await cleanupTenant(ownerClient, tenantA.organizationId);
    await cleanupTenant(ownerClient, tenantB.organizationId);
    await ownerClient.end();
    await appClient.end();
  });

  describe("(1) structural — every registered tenant-scoped model is RLS-backed", () => {
    it("the tenancy registry is non-empty (guards against an import/build regression)", () => {
      expect(REGISTRY.size).toBeGreaterThan(0);
    });

    it("every tenant-scoped model maps to a known table", () => {
      const unmapped: string[] = [];
      for (const modelName of REGISTRY.keys()) {
        if (!MODEL_TO_TABLE.has(modelName)) unmapped.push(modelName);
      }
      expect(
        unmapped,
        "registry models with no Prisma model of the same name — a rename left the registry stale"
      ).toEqual([]);
    });

    it("every tenant-scoped table has RLS ENABLED and FORCEd", async () => {
      const offenders: string[] = [];
      for (const modelName of REGISTRY.keys()) {
        const table = MODEL_TO_TABLE.get(modelName);
        if (table === undefined) continue; // covered by the test above
        const result = await ownerClient.query<{
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1`,
          [table]
        );
        const row = result.rows[0];
        if (row === undefined) {
          offenders.push(`${modelName} (${table}): table not found`);
          continue;
        }
        if (!row.relrowsecurity) {
          offenders.push(`${modelName} (${table}): RLS not ENABLED`);
        }
        if (!row.relforcerowsecurity) {
          // Without FORCE, the table owner bypasses RLS — the exact
          // "RLS silently does nothing" trap.
          offenders.push(`${modelName} (${table}): RLS not FORCEd`);
        }
      }
      expect(
        offenders,
        "tenant-scoped models whose tables are not fully RLS-protected — add ENABLE + FORCE ROW LEVEL SECURITY in a migration"
      ).toEqual([]);
    });

    it("every tenant-scoped table carries an org-isolation policy", async () => {
      const offenders: string[] = [];
      for (const modelName of REGISTRY.keys()) {
        const table = MODEL_TO_TABLE.get(modelName);
        if (table === undefined) continue;
        // The canonical isolation predicate references the org GUC
        // (`pharmax.organization_id`); the Organization table's own
        // policy compares `id` to the same GUC, so the reference is
        // present there too. We assert at least one policy on the
        // table mentions it.
        const result = await ownerClient.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = $1
              AND (qual LIKE '%pharmax.organization_id%'
                OR with_check LIKE '%pharmax.organization_id%')`,
          [table]
        );
        if (Number(result.rows[0]?.count ?? "0") < 1) {
          offenders.push(`${modelName} (${table})`);
        }
      }
      expect(
        offenders,
        "tenant-scoped tables with no policy referencing pharmax.organization_id — RLS is enabled but nothing scopes reads to the active org"
      ).toEqual([]);
    });
  });

  describe("(2) behavioral — pharmax_app under tenant A cannot see tenant B", () => {
    it("tenant A context: zero tenant B rows, but tenant A rows ARE visible", async () => {
      await setTenantContext(appClient, tenantA.organizationId);

      // `organization` keys the predicate on `id`, every other table
      // on `organizationId` — but in both cases the value we filter
      // for IS the tenant's organization id (the Organization row's
      // PK equals its own organizationId).
      const leaks: string[] = [];
      const missing: string[] = [];
      for (const { table, orgColumn } of SEEDED_BEHAVIORAL_TABLES) {
        const visibleB = await countWhereOrg(appClient, table, orgColumn, tenantB.organizationId);
        if (visibleB !== 0) {
          leaks.push(`${table}: ${visibleB} tenant-B row(s) visible under tenant-A context`);
        }

        const visibleA = await countWhereOrg(appClient, table, orgColumn, tenantA.organizationId);
        if (visibleA < 1) {
          // Guards against a false pass where the predicate hides
          // EVERYTHING (e.g. a broken GUC), which would make the
          // zero-B-rows assertion meaningless.
          missing.push(`${table}: tenant-A's own rows are not visible (count ${visibleA})`);
        }
      }

      expect(leaks, "cross-tenant row leakage under RLS").toEqual([]);
      expect(
        missing,
        "tenant-A rows unexpectedly hidden — the test's positive control failed"
      ).toEqual([]);
    });

    it("tenant B context: the mirror — zero tenant A rows", async () => {
      await setTenantContext(appClient, tenantB.organizationId);

      const leaks: string[] = [];
      for (const { table, orgColumn } of SEEDED_BEHAVIORAL_TABLES) {
        const visibleA = await countWhereOrg(appClient, table, orgColumn, tenantA.organizationId);
        if (visibleA !== 0) {
          leaks.push(`${table}: ${visibleA} tenant-A row(s) visible under tenant-B context`);
        }
      }
      expect(leaks, "cross-tenant row leakage under RLS (mirror direction)").toEqual([]);
    });
  });
});
