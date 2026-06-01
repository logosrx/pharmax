#!/usr/bin/env tsx
// scripts/check-raw-prisma-usage.ts
//
// Pre-merge guard. The canonical `prisma` export from
// `@pharmax/database` is the TENANCY-ENFORCED client (the tenancy
// extension auto-scopes every query to the active org and fails
// closed with no frame). The package ALSO exports `systemPrisma` —
// the RAW, UNSCOPED client that sees every organization's rows.
//
// `systemPrisma` is a deliberate, narrow escape hatch for code that
// legitimately operates across tenants (migrations, seed, bootstrap,
// supervisor drains that resolve a tenant from an external id BEFORE
// entering its tenancy). Importing it ANYWHERE ELSE re-opens the P0
// cross-tenant read leak this guard exists to prevent.
//
// This linter walks every TypeScript file under `apps/` and
// `packages/` and FAILS the build if a file outside the allowlist
// imports `systemPrisma` from `@pharmax/database`. Adding an entry to
// the allowlist is a SECURITY REVIEW EVENT — same bar as editing
// `prisma/migrations/rls-exempt.txt`. Every entry MUST be paired with
// a one-line justification comment and a reviewer sign-off.
//
// Exit codes:
//   0  No unapproved `systemPrisma` imports.
//   1  One or more unapproved imports found.
//   2  Internal error (filesystem / parse failure).
//
// Pairs with: scripts/check-migration-rls.ts (RLS coverage),
// scripts/check-command-files.ts (bus enforcement),
// scripts/check-prisma-schema.ts (model-shape rules).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

interface Violation {
  readonly file: string;
  readonly message: string;
}

const DATABASE_PACKAGE_IMPORT = "@pharmax/database";
const RAW_CLIENT_EXPORT = "systemPrisma";

// Directories (relative to repo root, POSIX separators) whose files
// are NEVER scanned. The database package DEFINES `systemPrisma`;
// node_modules and generated client are third-party / emitted.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "generated", "dist", ".next", "coverage"]);

// Allowlist of files (repo-root-relative, POSIX) permitted to import
// `systemPrisma`. EMPTY BY DESIGN — every entry weakens the tenant
// isolation boundary and needs an inline justification + reviewer
// sign-off. Example shape (keep alphabetized):
//
//   // Seed runs before any tenant exists; writes across orgs.
//   "prisma/seed.ts",
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Pure scanner: returns true iff `sourceText` contains an
 * `import { ... systemPrisma ... } from "@pharmax/database"`
 * declaration (named import, including aliased `systemPrisma as x`).
 * Unit-testable without filesystem access.
 */
export function importsRawClient(sourceText: string, fileName: string): boolean {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === DATABASE_PACKAGE_IMPORT) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            // `propertyName` is set for aliased imports
            // (`systemPrisma as x`); otherwise `name` is the import.
            const importedName = element.propertyName?.text ?? element.name.text;
            if (importedName === RAW_CLIENT_EXPORT) {
              found = true;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return found;
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
      acc.push(full);
    }
  }
}

export function checkRawPrismaUsage(rootDir: string): {
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
    if (importsRawClient(sourceText, file)) {
      violations.push({
        file: relPath,
        message: `imports \`${RAW_CLIENT_EXPORT}\` (the raw, UNSCOPED client) from "${DATABASE_PACKAGE_IMPORT}". Use the tenancy-enforced \`prisma\` (with \`withTenancyContext\` / \`readInOrgScope\` / \`readInTenantContext\`) instead, or add this file to the ALLOWLIST in scripts/check-raw-prisma-usage.ts with a justification and reviewer sign-off.`,
      });
    }
  }

  return { checked: files.length, violations };
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { checked, violations } = checkRawPrismaUsage(root);

  if (violations.length > 0) {
    process.stderr.write(`[check-raw-prisma-usage] ${violations.length} violation(s):\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}\n    ${v.message}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `[check-raw-prisma-usage] ok — ${checked} file(s) scanned, no unapproved systemPrisma imports\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main().catch((err) => {
    process.stderr.write(`[check-raw-prisma-usage] internal error: ${String(err)}\n`);
    process.exit(2);
  });
}
