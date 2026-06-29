#!/usr/bin/env tsx
// scripts/check-raw-sql-usage.ts
//
// Pre-merge guard. Raw SQL is where RLS bypasses hide.
//
// The tenancy-enforced `prisma` client auto-scopes every query to
// the active org and fails closed. But Prisma's raw-SQL escape
// hatches — `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`,
// `$executeRawUnsafe` — run SQL the tenancy extension never sees.
// A raw query that forgets a `WHERE "organizationId" = ...` clause
// (or runs on a connection without the org GUC set) reads ACROSS
// tenants. The `*Unsafe` variants additionally interpolate strings
// into SQL text — SQL-injection AND RLS bypass in one call.
//
// This linter walks every NON-TEST TypeScript file under `apps/`
// and `packages/` and FAILS the build if a file outside the
// allowlist invokes one of those four methods. Legitimate raw SQL
// (worker claim drains using `FOR UPDATE SKIP LOCKED`, the audit
// advisory-lock, the session-GUC setter itself) lives on the
// allowlist with a one-line justification.
//
// Adding an entry to the allowlist is a SECURITY REVIEW EVENT —
// same bar as editing `prisma/migrations/rls-exempt.txt` or the
// `systemPrisma` allowlist in scripts/check-raw-prisma-usage.ts.
// `$queryRawUnsafe` / `$executeRawUnsafe` should essentially NEVER
// be allowlisted: prefer the tagged-template (`$queryRaw\`...\``)
// or `Prisma.sql` parameterized forms, which the allowlisted
// callers already use.
//
// Test files (`*.test.ts`, `*.spec.ts`) are NOT scanned: they run
// against a disposable test database, not production tenant data,
// so raw SQL there is not a cross-tenant leak vector — and the
// integration suite uses raw SQL by design (see
// packages/integration-tests/src/lib/seed.ts).
//
// Exit codes:
//   0  No unapproved raw-SQL calls.
//   1  One or more unapproved calls found.
//   2  Internal error (filesystem / parse failure).
//
// Pairs with: scripts/check-raw-prisma-usage.ts (raw client import),
// scripts/check-migration-rls.ts (RLS coverage),
// packages/integration-tests/src/cross-tenant-isolation.test.ts
// (DB-truth proof).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

interface Violation {
  readonly file: string;
  readonly message: string;
}

interface RawSqlCall {
  readonly method: string;
  readonly line: number;
}

// The Prisma raw-SQL escape hatches we forbid outside the allowlist.
const RAW_SQL_METHODS: ReadonlySet<string> = new Set([
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
]);

// Directories never scanned. The database package DEFINES the raw
// client; node_modules / generated / build output are third-party
// or emitted.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "generated", "dist", ".next", "coverage"]);

// Allowlist of files (repo-root-relative, POSIX) permitted to call
// the raw-SQL methods. Each entry MUST carry a one-line
// justification and a reviewer sign-off. Keep alphabetized.
//
// The common, legitimate pattern is a worker/system drain that
// claims rows with `FOR UPDATE SKIP LOCKED` across tenants under
// the `pharmax_system` role, resolves the owning org, and ENTERS
// that org's tenancy before doing any domain work — plus a small
// number of infrastructure primitives (the session-GUC setter and
// the audit-chain advisory lock).
const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // FOR UPDATE SKIP LOCKED claim of sent print jobs (agent context).
  "apps/print-agent/src/claim-sent-print-job.ts",
  // Operator role-code read; runs inside the request's tenancy tx
  // with the org GUC already set (tenant-scoped raw read).
  "apps/web/src/server/auth/load-operator-role-codes.ts",
  // Cross-tenant FedEx shipment claim drain (system context).
  "apps/worker/src/drains/claim-active-fedex-shipments.ts",
  // Cross-tenant UPS shipment claim drain (system context).
  "apps/worker/src/drains/claim-active-ups-shipments.ts",
  // SLA breach claim drain — FOR UPDATE SKIP LOCKED (system context).
  "apps/worker/src/drains/claim-breached-orders.ts",
  // NPI-sync due-org claim drain (system context).
  "apps/worker/src/drains/claim-due-orgs-for-npi-sync.ts",
  // Report-schedule due claim drain (system context).
  "apps/worker/src/drains/claim-due-report-schedules.ts",
  // EasyPost webhook-event claim drain (platform ledger, system ctx).
  "apps/worker/src/drains/claim-easypost-webhook-events.ts",
  // Event-outbox claim drain — FOR UPDATE SKIP LOCKED (system ctx).
  "apps/worker/src/drains/claim-outbox-events.ts",
  // Stripe webhook-event claim drain (platform ledger, system ctx).
  "apps/worker/src/drains/claim-stripe-webhook-events.ts",
  // Read-only per-org bucket-count aggregate for metrics (system ctx).
  "apps/worker/src/metrics/workflow-bucket-scraper.ts",
  // Per-org audit-chain serialization via pg_advisory_xact_lock.
  "packages/audit/src/chain/writer.ts",
  // Command-bus transaction internals (row locks / claims).
  "packages/command-bus/src/define-command.ts",
  // Permission load; runs inside the tenancy tx with the org GUC set.
  "packages/rbac/src/prisma-permission-loader.ts",
  // THE tenant-scoping primitive: sets pharmax.organization_id /
  // pharmax.system_context via set_config(). This is the helper the
  // whole RLS model depends on.
  "packages/tenancy/src/session-guc.ts",
]);

/**
 * Pure scanner: returns every raw-SQL method call (by name + line)
 * in `sourceText`. A "call" is a property access whose name is one
 * of the four forbidden methods — this matches BOTH the
 * tagged-template form (`client.$queryRaw\`...\``) and the call
 * form (`tx.$queryRaw(...)`). Interface/type members
 * (`$executeRaw(...)` in an `interface`), object-literal mock keys
 * (`{ $queryRaw: vi.fn() }`), and comments are NOT property-access
 * expressions, so they are correctly ignored. Unit-testable
 * without filesystem access.
 */
export function findRawSqlCalls(sourceText: string, fileName: string): ReadonlyArray<RawSqlCall> {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);
  const calls: RawSqlCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && RAW_SQL_METHODS.has(node.name.text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.name.getStart(source));
      calls.push({ method: node.name.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return calls;
}

function isTestFile(path: string): boolean {
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx") ||
    path.endsWith(".spec.ts") ||
    path.endsWith(".spec.tsx")
  );
}

function walkTsFiles(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (stat.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      if (full.endsWith(".d.ts")) continue;
      if (isTestFile(full)) continue;
      acc.push(full);
    }
  }
}

export function checkRawSqlUsage(rootDir: string): {
  readonly checked: number;
  readonly violations: ReadonlyArray<Violation>;
} {
  const files: string[] = [];
  for (const top of ["apps", "packages"]) {
    walkTsFiles(join(rootDir, top), files);
  }

  const violations: Violation[] = [];
  for (const file of files) {
    const relPath = relative(rootDir, file).split("\\").join("/");
    // The database package owns the raw client; never flag it.
    if (relPath.startsWith("packages/database/")) continue;
    if (ALLOWLIST.has(relPath)) continue;
    const sourceText = readFileSync(file, "utf8");
    const calls = findRawSqlCalls(sourceText, file);
    if (calls.length > 0) {
      const detail = calls.map((c) => `${c.method} (line ${c.line})`).join(", ");
      violations.push({
        file: relPath,
        message: `invokes raw SQL [${detail}]. Raw SQL bypasses the tenancy extension's auto-scoping — use the tenancy-enforced \`prisma\` client, or if this is a deliberate cross-tenant/system query, add this file to the ALLOWLIST in scripts/check-raw-sql-usage.ts with a justification and reviewer sign-off. Never allowlist \`*Unsafe\` variants; use the tagged-template or \`Prisma.sql\` parameterized form instead.`,
      });
    }
  }

  return { checked: files.length, violations };
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { checked, violations } = checkRawSqlUsage(root);

  if (violations.length > 0) {
    process.stderr.write(`[check-raw-sql-usage] ${violations.length} violation(s):\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}\n    ${v.message}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `[check-raw-sql-usage] ok — ${checked} file(s) scanned, no unapproved raw-SQL calls\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main().catch((err) => {
    process.stderr.write(`[check-raw-sql-usage] internal error: ${String(err)}\n`);
    process.exit(2);
  });
}
