import { describe, it, expect } from "vitest";

import {
  checkMigrations,
  extractCreatedTables,
  hasRlsCoverage,
  loadExemptions,
} from "./check-migration-rls.js";

describe("loadExemptions", () => {
  it("strips comments and blank lines, lowercases names", () => {
    const raw = [
      "# Header comment",
      "",
      "Permission   ",
      "  role_permission",
      "# inline comment ignored",
      "clinic_site",
    ].join("\n");
    const set = loadExemptions(raw);
    expect(set.size).toBe(3);
    expect(set.has("permission")).toBe(true);
    expect(set.has("role_permission")).toBe(true);
    expect(set.has("clinic_site")).toBe(true);
  });

  it("returns empty set for an empty file", () => {
    expect(loadExemptions("").size).toBe(0);
  });
});

describe("extractCreatedTables", () => {
  it("finds quoted table names from CREATE TABLE statements", () => {
    const sql = `
      -- whatever
      CREATE TABLE "patient" (id uuid);
      CREATE TABLE IF NOT EXISTS "prescription" (id uuid);
    `;
    expect(extractCreatedTables(sql)).toEqual(["patient", "prescription"]);
  });

  it("returns [] when the file contains no CREATE TABLE", () => {
    expect(extractCreatedTables(`ALTER TABLE "patient" ADD COLUMN ...;`)).toEqual([]);
  });

  it("does not match CREATE INDEX, CREATE TYPE, etc.", () => {
    const sql = `
      CREATE TYPE "Status" AS ENUM ('A','B');
      CREATE INDEX "ix_patient_org" ON "patient" ("organizationId");
    `;
    expect(extractCreatedTables(sql)).toEqual([]);
  });
});

describe("hasRlsCoverage — literal ENABLE + CREATE POLICY", () => {
  it("accepts paired ENABLE + CREATE POLICY for the same table", () => {
    const sql = `
      ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "patient"
        USING ("organizationId" = current_setting('pharmax.organization_id')::uuid);
    `;
    expect(hasRlsCoverage(sql, "patient")).toBe(true);
  });

  it("rejects ENABLE without a matching policy", () => {
    const sql = `
      ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
    `;
    expect(hasRlsCoverage(sql, "patient")).toBe(false);
  });

  it("rejects CREATE POLICY without ENABLE", () => {
    const sql = `
      CREATE POLICY foo ON "patient" USING (true);
    `;
    expect(hasRlsCoverage(sql, "patient")).toBe(false);
  });

  it("does not confuse policies on a different table", () => {
    const sql = `
      ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "prescription" USING (true);
    `;
    expect(hasRlsCoverage(sql, "patient")).toBe(false);
  });
});

describe("hasRlsCoverage — DO block templated form", () => {
  it("accepts a DO block that lists the table in std_tables and templates CREATE POLICY + ENABLE", () => {
    const sql = `
      ALTER TABLE "clinic" ENABLE ROW LEVEL SECURITY;
      DO $$
      DECLARE
        t text;
        std_tables text[] := ARRAY['clinic', 'team', 'bucket'];
      BEGIN
        FOREACH t IN ARRAY std_tables LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (true)', t);
        END LOOP;
      END$$;
    `;
    expect(hasRlsCoverage(sql, "clinic")).toBe(true);
    expect(hasRlsCoverage(sql, "team")).toBe(true);
    expect(hasRlsCoverage(sql, "bucket")).toBe(true);
  });

  it("rejects DO block that lists the table but does not template CREATE POLICY", () => {
    const sql = `
      ALTER TABLE "clinic" ENABLE ROW LEVEL SECURITY;
      DO $$
      DECLARE
        t text;
        std_tables text[] := ARRAY['clinic'];
      BEGIN
        FOREACH t IN ARRAY std_tables LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        END LOOP;
      END$$;
    `;
    expect(hasRlsCoverage(sql, "clinic")).toBe(false);
  });
});

describe("checkMigrations — integration shape", () => {
  it("returns no violations when every created table is RLS-covered", () => {
    const sql = `
      CREATE TABLE "patient" (id uuid);
      ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "patient" USING (true);
    `;
    const out = checkMigrations({
      migrations: [{ file: "0001/migration.sql", sql }],
      exemptions: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("returns no violations when the only created table is exempt", () => {
    const sql = `CREATE TABLE "permission" (id uuid);`;
    const out = checkMigrations({
      migrations: [{ file: "0001/migration.sql", sql }],
      exemptions: new Set(["permission"]),
    });
    expect(out).toEqual([]);
  });

  it("flags a missing RLS pairing", () => {
    const sql = `CREATE TABLE "patient" (id uuid);`;
    const out = checkMigrations({
      migrations: [{ file: "0001/migration.sql", sql }],
      exemptions: new Set(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: "0001/migration.sql", table: "patient" });
  });

  it("flags DISABLE ROW LEVEL SECURITY as a hard failure regardless of exemption list", () => {
    const sql = `ALTER TABLE "patient" DISABLE ROW LEVEL SECURITY;`;
    const out = checkMigrations({
      migrations: [{ file: "0001/migration.sql", sql }],
      exemptions: new Set(["patient"]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toMatch(/DISABLE ROW LEVEL SECURITY/);
  });

  it("a later migration may bring an earlier CREATE TABLE under RLS (baseline + rls_baseline pattern)", () => {
    const m1 = `CREATE TABLE "patient" (id uuid);`;
    const m2 = `
      ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "patient" USING (true);
    `;
    const out = checkMigrations({
      migrations: [
        { file: "0001/migration.sql", sql: m1 },
        { file: "0002/migration.sql", sql: m2 },
      ],
      exemptions: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("flags a CREATE TABLE that is NEVER brought under RLS (no follow-up migration either)", () => {
    const m1 = `CREATE TABLE "patient" (id uuid);`;
    const m2 = `ALTER TABLE "patient" ADD COLUMN "name" text;`;
    const out = checkMigrations({
      migrations: [
        { file: "0001/migration.sql", sql: m1 },
        { file: "0002/migration.sql", sql: m2 },
      ],
      exemptions: new Set(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("0001/migration.sql");
  });

  it("does NOT consider a later migration's RLS for a table created EARLIER than the lookup window (regression guard)", () => {
    // Migration 0002 creates "patient" but only 0001 has RLS coverage
    // for a different table — the RLS coverage must appear at or
    // after the CREATE, not before it.
    const m1 = `
      ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "patient" USING (true);
    `;
    const m2 = `CREATE TABLE "patient" (id uuid);`;
    const out = checkMigrations({
      migrations: [
        { file: "0001/migration.sql", sql: m1 },
        { file: "0002/migration.sql", sql: m2 },
      ],
      exemptions: new Set(),
    });
    // In this synthetic case, hasRlsCoverage(m2, "patient") is
    // false; the only coverage is in m1 which is BEFORE the CREATE.
    // The walker only looks at migrations[i..end], so this fails.
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("0002/migration.sql");
  });
});

describe("checkMigrations — baseline + RLS baseline integration", () => {
  it("the live exemption list covers the four non-tenant tables (regression sentinel)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..");
    const exemptions = loadExemptions(
      readFileSync(join(root, "prisma", "migrations", "rls-exempt.txt"), "utf8")
    );
    for (const t of ["permission", "role_permission", "clinic_site", "stripe_webhook_event"]) {
      expect(exemptions.has(t)).toBe(true);
    }
  });

  it("the live migration set has zero violations", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..");
    const exemptions = loadExemptions(
      readFileSync(join(root, "prisma", "migrations", "rls-exempt.txt"), "utf8")
    );
    const { listMigrationFiles } = await import("./check-migration-rls.js");
    const files = listMigrationFiles(join(root, "prisma", "migrations"));
    const migrations = files.map((file) => ({ file, sql: readFileSync(file, "utf8") }));
    const violations = checkMigrations({ migrations, exemptions });
    expect(violations).toEqual([]);
  });
});
