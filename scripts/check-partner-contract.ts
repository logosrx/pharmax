#!/usr/bin/env tsx
// scripts/check-partner-contract.ts
//
// Pre-merge guard for the PARTNER API WIRE CONTRACT (ADR-0032,
// ADR-0040). `docs/api/openapi-v1.yaml` is the committed contract
// for the public /api/v1 surface; prescribers and clinic
// integrations are built against it, so a route that ships without a
// spec entry (or a spec entry that outlives its route) is a silent
// breaking change to every partner.
//
// What this gate enforces, in both directions:
//
//   1. ROUTE → SPEC: every HTTP method exported by a
//      `apps/web/app/api/v1/**/route.ts` file has a matching
//      operation in the spec (`[param]` directories map to
//      `{param}` path templates).
//   2. SPEC → ROUTE: every documented operation has a live route
//      export — the spec cannot document phantom endpoints.
//   3. Every documented operation declares the responses the shared
//      partner-context layer can produce on ANY route: 401
//      (resolvePartnerContext) and 429 (per-key quota tiers).
//   4. Every mutation (non-GET) operation declares a 400 response
//      and the `Idempotency-Key` header parameter — the v1 mutation
//      contract from ADR-0032.
//
// The RESPONSE-SHAPE side of the contract (exact envelope fields per
// status code) is locked by `apps/web/app/api/v1/contract.test.ts`,
// which replays real handler responses against this same spec. The
// two gates together mean: paths/methods cannot drift here, and
// bodies cannot drift there.
//
// Exit codes:
//   0  Spec and route tree agree.
//   1  Contract drift (violations listed on stderr).
//   2  Internal error (unreadable spec / filesystem failure).
//
// Pairs with: scripts/check-command-files.ts (command-file shape)
// and the other `check:*` safety linters in the `verify` chain.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { parse as parseYaml } from "yaml";

export interface Violation {
  readonly where: string;
  readonly message: string;
}

const HTTP_METHOD_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Keys of an OpenAPI path item that are NOT HTTP methods.
const NON_METHOD_PATH_ITEM_KEYS = new Set(["parameters", "summary", "description", "servers"]);

/**
 * Extract the HTTP methods a Next.js route module exports. Uses the
 * TypeScript AST (not regex) so commented-out handlers and string
 * mentions don't count. Recognizes `export async function GET(...)`
 * and `export const GET = ...` — the two shapes Next accepts.
 */
export function extractRouteMethods(sourceText: string, fileName: string): ReadonlyArray<string> {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const methods: string[] = [];

  const isExported = (node: ts.HasModifiers): boolean =>
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (isExported(statement) && HTTP_METHOD_EXPORTS.has(statement.name.text)) {
        methods.push(statement.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && HTTP_METHOD_EXPORTS.has(decl.name.text)) {
          methods.push(decl.name.text);
        }
      }
    }
  }
  return methods;
}

/**
 * Map a route directory (relative to the v1 root) onto its OpenAPI
 * path template: `` → `/`, `orders` → `/orders`,
 * `orders/[orderId]` → `/orders/{orderId}`. Always uses `/` in the
 * output regardless of platform separator.
 */
export function routeDirToSpecPath(relDir: string): string {
  const segments = relDir === "" ? [] : relDir.split(sep);
  const mapped = segments.map((segment) =>
    segment.startsWith("[") && segment.endsWith("]") ? `{${segment.slice(1, -1)}}` : segment
  );
  return `/${mapped.join("/")}`;
}

export interface RouteEntry {
  /** OpenAPI path template, e.g. `/orders/{orderId}`. */
  readonly specPath: string;
  /** Uppercase HTTP methods exported by the route module. */
  readonly methods: ReadonlyArray<string>;
  /** Route file path, for error messages. */
  readonly file: string;
}

/** Recursively collect `route.ts` files under the v1 route root. */
export function collectV1Routes(v1Dir: string): ReadonlyArray<RouteEntry> {
  const entries: RouteEntry[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name !== "route.ts") continue;
      const sourceText = readFileSync(full, "utf8");
      const methods = extractRouteMethods(sourceText, full);
      entries.push({
        specPath: routeDirToSpecPath(relative(v1Dir, dir)),
        methods,
        file: full,
      });
    }
  };

  walk(v1Dir);
  return entries;
}

interface SpecOperation {
  readonly responses?: Record<string, unknown>;
  readonly parameters?: ReadonlyArray<Record<string, unknown>>;
}

export interface SpecDocument {
  readonly paths?: Record<string, Record<string, unknown>>;
}

function operationParameters(op: SpecOperation): ReadonlyArray<Record<string, unknown>> {
  return op.parameters ?? [];
}

function declaresIdempotencyKey(op: SpecOperation): boolean {
  return operationParameters(op).some(
    (p) =>
      p["$ref"] === "#/components/parameters/IdempotencyKey" ||
      (p["in"] === "header" &&
        typeof p["name"] === "string" &&
        p["name"].toLowerCase() === "idempotency-key")
  );
}

/**
 * Diff the live route tree against the committed spec. Pure — takes
 * data, returns violations — so the unit tests can feed synthetic
 * trees and the CLI/sentinel feed the real ones.
 */
export function diffContract(
  routes: ReadonlyArray<RouteEntry>,
  spec: SpecDocument
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const specPaths = spec.paths ?? {};

  const specOps = new Map<string, SpecOperation>();
  for (const [specPath, pathItem] of Object.entries(specPaths)) {
    for (const [key, value] of Object.entries(pathItem)) {
      if (NON_METHOD_PATH_ITEM_KEYS.has(key)) continue;
      specOps.set(`${key.toUpperCase()} ${specPath}`, value as SpecOperation);
    }
  }

  const routeOps = new Set<string>();
  for (const route of routes) {
    if (route.methods.length === 0) {
      violations.push({
        where: route.file,
        message: "route.ts exports no HTTP method handlers",
      });
    }
    for (const method of route.methods) {
      routeOps.add(`${method} ${route.specPath}`);
    }
  }

  // Direction 1: every live route operation is documented.
  for (const route of routes) {
    for (const method of route.methods) {
      const opKey = `${method} ${route.specPath}`;
      if (!specOps.has(opKey)) {
        violations.push({
          where: route.file,
          message:
            `${opKey} is served but not documented in the spec — ` +
            "add the operation to docs/api/openapi-v1.yaml",
        });
      }
    }
  }

  // Direction 2: every documented operation has a live route.
  for (const opKey of specOps.keys()) {
    if (!routeOps.has(opKey)) {
      violations.push({
        where: "docs/api/openapi-v1.yaml",
        message:
          `${opKey} is documented but no route.ts exports it — ` +
          "remove the operation or restore the route",
      });
    }
  }

  // Shared-layer response guarantees + the mutation contract.
  for (const [opKey, op] of specOps) {
    const responses = op.responses ?? {};
    const method = opKey.split(" ")[0] ?? "";
    for (const required of ["401", "429"]) {
      if (!(required in responses)) {
        violations.push({
          where: "docs/api/openapi-v1.yaml",
          message:
            `${opKey} does not document a ${required} response — every v1 route ` +
            "can return it via the shared partner-context layer",
        });
      }
    }
    if (method !== "GET") {
      if (!("400" in responses)) {
        violations.push({
          where: "docs/api/openapi-v1.yaml",
          message: `${opKey} is a mutation but does not document a 400 response`,
        });
      }
      if (!declaresIdempotencyKey(op)) {
        violations.push({
          where: "docs/api/openapi-v1.yaml",
          message:
            `${opKey} is a mutation but does not declare the Idempotency-Key ` +
            "header parameter (v1 mutation contract, ADR-0032)",
        });
      }
    }
  }

  return violations;
}

export const SPEC_RELATIVE_PATH = join("docs", "api", "openapi-v1.yaml");
export const V1_ROUTES_RELATIVE_PATH = join("apps", "web", "app", "api", "v1");

export function runCheck(repoRoot: string): {
  readonly routes: ReadonlyArray<RouteEntry>;
  readonly violations: ReadonlyArray<Violation>;
} {
  const specText = readFileSync(join(repoRoot, SPEC_RELATIVE_PATH), "utf8");
  const spec = parseYaml(specText) as SpecDocument;
  const routes = collectV1Routes(join(repoRoot, V1_ROUTES_RELATIVE_PATH));
  return { routes, violations: diffContract(routes, spec) };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { routes, violations } = runCheck(root);

  if (violations.length > 0) {
    process.stderr.write(`[check-partner-contract] ${violations.length} violation(s):\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.where}\n    ${v.message}\n`);
    }
    process.exit(1);
  }

  const operationCount = routes.reduce((n, r) => n + r.methods.length, 0);
  process.stdout.write(
    `[check-partner-contract] ok — ${operationCount} operation(s) across ` +
      `${routes.length} route file(s) match ${SPEC_RELATIVE_PATH}\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[check-partner-contract] internal error: ${String(err)}\n`);
    process.exit(2);
  }
}
