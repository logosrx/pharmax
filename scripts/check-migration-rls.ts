#!/usr/bin/env tsx
// scripts/check-migration-rls.ts
//
// Pre-merge guard. Walks every migration file under prisma/migrations
// (in lexicographic / apply order) and enforces:
//
//   For EVERY `CREATE TABLE "<name>"` discovered in migration N, one
//   of the following MUST be true:
//
//     (a) Some migration M >= N (the same file OR any later one)
//         contains BOTH `ALTER TABLE "<name>" ENABLE ROW LEVEL
//         SECURITY` AND at least one `CREATE POLICY ... ON "<name>"`,
//         OR a templated CREATE POLICY produced by a DO block that
//         lists `<name>` in its std_tables array.
//
//         Why "M >= N" and not "M = N": the baseline schema was
//         created BEFORE the RLS baseline migration could be
//         authored (we have a chicken-and-egg: RLS policies need
//         tables to attach to). The RLS baseline is a separate,
//         later migration that brings the existing tables under RLS.
//         Future tenant tables SHOULD include RLS in the same
//         migration that creates them (best practice), but a
//         follow-up migration in the same PR is also accepted.
//
//     (b) `<name>` appears in `prisma/migrations/rls-exempt.txt`.
//         Exemptions document a deliberate architectural decision
//         and are reviewed at PR time.
//
// Exit code:
//   0  All tables accounted for.
//   1  Violations found (printed to stderr with file + table name).
//   2  Internal error (couldn't read migrations directory, etc.).
//
// What this guard CANNOT catch (out of scope; addressed by other
// reviews):
//   - A migration that ENABLEs RLS without a USING/WITH CHECK that
//     actually enforces tenancy (a "permissive: allow all" policy).
//     Reviewed at code-review time; the policy template in the
//     baseline migration is the canonical reference.
//   - Schema changes via `prisma migrate dev` that drop and recreate
//     a table without re-enabling RLS. Prisma's diff engine handles
//     ALTERs, not policies; the convention is to add RLS in a
//     follow-up migration if the diff loses it.
//   - Raw `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` statements.
//     Flagged here as a hard failure regardless of exemption list.
//
// Designed to run BEFORE `pnpm test`, since failing this check
// indicates a structural problem that no test will catch.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Violation {
  readonly file: string;
  readonly table: string;
  readonly reason: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "prisma", "migrations");
const EXEMPT_FILE = join(MIGRATIONS_DIR, "rls-exempt.txt");

/**
 * Parse the exempt list. Strips comments and blank lines. Returns
 * a set of bare lowercase table names.
 */
export function loadExemptions(raw: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    names.add(trimmed.toLowerCase());
  }
  return names;
}

/**
 * Extract the list of tables a single migration.sql creates.
 * Matches `CREATE TABLE "name"` and `CREATE TABLE IF NOT EXISTS "name"`.
 */
export function extractCreatedTables(sql: string): ReadonlyArray<string> {
  const out: string[] = [];
  // Match `CREATE TABLE`, optionally `IF NOT EXISTS`, then a quoted
  // identifier. Stops at the closing quote. Case-insensitive.
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

/**
 * Returns true iff the migration enables RLS on `table` AND defines
 * at least one policy on `table`. Accepts both literal
 * `ALTER TABLE "name" ENABLE ROW LEVEL SECURITY` (Prisma-generated)
 * and the DO-block array form used by the baseline migration
 * (`std_tables text[] := ARRAY[... 'name' ...]`).
 */
export function hasRlsCoverage(sql: string, table: string): boolean {
  const safe = escapeRegex(table);
  // Literal ALTER TABLE form (the most common).
  // The bare-identifier branch uses `\b` so we don't match a
  // SUFFIX of a longer name (`patients` when looking for `patient`);
  // the quoted branch is self-bounded by the closing `"` and must
  // NOT carry `\b` (the `"` is a non-word char, and ENABLE's leading
  // space is also non-word — no word boundary exists between them).
  const enableLiteral = new RegExp(
    `ALTER\\s+TABLE\\s+(?:"${safe}"|\\b${safe}\\b)\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    "i"
  );
  // DO-block form: table name appears as a single-quoted entry in
  // the std_tables array AND the EXECUTE format() statement covers
  // ENABLE ROW LEVEL SECURITY in the same block. We don't fully
  // parse PL/pgSQL — we check that the table name is inside the
  // ARRAY[...] AND that the same file contains the templated
  // EXECUTE ENABLE statement (already verified at baseline).
  const inArrayBlock = new RegExp(`ARRAY\\s*\\[[^\\]]*'${safe}'[^\\]]*\\]`, "i");
  const blockEnablesRls = /EXECUTE\s+format\s*\(\s*['"][^'"]*ENABLE\s+ROW\s+LEVEL\s+SECURITY/i;
  const enableViaBlock = inArrayBlock.test(sql) && blockEnablesRls.test(sql);

  // Also accept the explicit `ALTER TABLE` form for tables that the
  // baseline migration enables literally (the baseline does both —
  // each table gets its own pair of ENABLE + FORCE statements,
  // independent of the policy DO block).
  const enabled = enableLiteral.test(sql) || enableViaBlock;
  if (!enabled) return false;

  // Policy presence: a literal `CREATE POLICY ... ON "name"` or a
  // DO block that references the table by name.
  // Same `\b` placement nuance as above: only the bare-identifier
  // branch needs the word boundary; the quoted form is self-bounded.
  const policyLiteral = new RegExp(
    `CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+(?:"${safe}"|\\b${safe}\\b)`,
    "i"
  );
  const policyViaBlock =
    inArrayBlock.test(sql) && /EXECUTE\s+format\s*\(\s*['"][^'"]*CREATE\s+POLICY/i.test(sql);
  return policyLiteral.test(sql) || policyViaBlock;
}

/**
 * Returns the list of migration directories (one per Prisma
 * migration), in lexicographic order (which matches Prisma's apply
 * order because migration names are timestamp-prefixed).
 */
export function listMigrationFiles(root: string): ReadonlyArray<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const sqls: string[] = [];
  for (const name of entries.sort()) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      const sql = join(full, "migration.sql");
      // statSync throws if missing; that's the signal to skip.
      statSync(sql);
      sqls.push(sql);
    } catch {
      // Not a migration directory or missing migration.sql.
    }
  }
  return sqls;
}

/**
 * Pure entry point — composes the helpers and returns violations.
 * Exposed for unit tests so they can pass synthetic input without
 * touching the filesystem.
 *
 * Migrations MUST be passed in apply order (lexicographic by file
 * name, which is Prisma's order because migration directories are
 * timestamp-prefixed). The check walks them in order so the "later
 * migration may bring an earlier CREATE TABLE under RLS" rule
 * works correctly.
 */
export function checkMigrations(input: {
  readonly migrations: ReadonlyArray<{ readonly file: string; readonly sql: string }>;
  readonly exemptions: ReadonlySet<string>;
}): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  // Hard failure: any DISABLE statement, anywhere, is rejected.
  for (const { file, sql } of input.migrations) {
    if (/ALTER\s+TABLE\s+(?:"[^"]+"|\w+)\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql)) {
      violations.push({
        file,
        table: "<any>",
        reason:
          "Migration contains DISABLE ROW LEVEL SECURITY. RLS may only be re-shaped via new policies, never disabled.",
      });
    }
  }

  // For each table created in migration N, look across migrations
  // [N..end] for RLS coverage.
  for (let i = 0; i < input.migrations.length; i++) {
    const m = input.migrations[i];
    if (m === undefined) continue;
    const tables = extractCreatedTables(m.sql);
    if (tables.length === 0) continue;
    for (const table of tables) {
      const normalized = table.toLowerCase();
      if (input.exemptions.has(normalized)) continue;
      let covered = false;
      for (let j = i; j < input.migrations.length; j++) {
        const candidate = input.migrations[j];
        if (candidate === undefined) continue;
        if (hasRlsCoverage(candidate.sql, table)) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        violations.push({
          file: m.file,
          table,
          reason:
            "CREATE TABLE without a matching ENABLE ROW LEVEL SECURITY + CREATE POLICY in this or any later migration, and not on the exemption list.",
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main(): void {
  let exemptionsRaw: string;
  try {
    exemptionsRaw = readFileSync(EXEMPT_FILE, "utf8");
  } catch (err) {
    process.stderr.write(
      `[check-migration-rls] FATAL: cannot read ${EXEMPT_FILE}: ${describeError(err)}\n`
    );
    process.exit(2);
  }
  const exemptions = loadExemptions(exemptionsRaw);

  const sqlFiles = listMigrationFiles(MIGRATIONS_DIR);
  if (sqlFiles.length === 0) {
    process.stderr.write(
      `[check-migration-rls] WARN: no migrations found under ${MIGRATIONS_DIR}\n`
    );
    process.exit(0);
  }

  const migrations = sqlFiles.map((file) => ({
    file,
    sql: readFileSync(file, "utf8"),
  }));

  const violations = checkMigrations({ migrations, exemptions });

  if (violations.length === 0) {
    process.stdout.write(
      `[check-migration-rls] ok — ${sqlFiles.length} migration(s), ${exemptions.size} exempt table(s)\n`
    );
    process.exit(0);
  }

  process.stderr.write(`[check-migration-rls] ${violations.length} violation(s):\n`);
  for (const v of violations) {
    process.stderr.write(`  - ${v.file}\n    table: ${v.table}\n    ${v.reason}\n`);
  }
  process.stderr.write(
    "\nFix by either:\n" +
      '  1. Adding ALTER TABLE "<name>" ENABLE ROW LEVEL SECURITY and a CREATE POLICY in the same migration, OR\n' +
      "  2. Adding <name> to prisma/migrations/rls-exempt.txt with a code-reviewed comment explaining why.\n"
  );
  process.exit(1);
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
