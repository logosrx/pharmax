#!/usr/bin/env tsx
// scripts/check-command-files.ts
//
// Pre-merge guard. Walks every TypeScript file under
// `packages/*/src/commands/` (excluding `*.test.ts` and `index.ts`)
// and asserts that the file is shaped like a real command.
//
// What "shaped like a real command" means:
//
//   The file must export a const whose initializer is one of:
//
//     (a) `defineCommand<...>({...})` — the factory call from
//         `@pharmax/command-bus` that produces a regular tenant
//         command. Used by every workflow command.
//
//     (b) An object literal annotated with `Command<...>` — the
//         shorthand for a regular command without the factory
//         (Phase 1 cross-cutting commands like RegisterPatient).
//
//     (c) An object literal annotated with `SystemCommand<...>` —
//         the system-context command used during bootstrap
//         (CreateOrganization).
//
// Why this matters: the 20-step orchestrator from
// `docs/ARCHITECTURE_PRINCIPLES.md` §C.3 ("`defineCommand()`
// factory before the first workflow command") only fires when
// commands go through the bus. A file in `commands/` that
// accidentally exports a plain async function would be invisible
// to the bus, bypassing idempotency, row locks, audit-chain
// writes, and event_outbox emission. That regression must fail
// the build, not the runtime.
//
// Exit codes:
//   0  All command files conform.
//   1  One or more files don't.
//   2  Internal error (couldn't parse a file or read the
//      filesystem).
//
// Pairs with: scripts/check-prisma-schema.ts (model-shape rules)
// and scripts/check-migration-rls.ts (RLS coverage). The three
// linters form the "no command lands without
// (defineCommand + tenant-scoped model + RLS policy)" net.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

interface Violation {
  readonly file: string;
  readonly message: string;
}

const COMMAND_FILE_EXCLUDES = new Set(["index.ts"]);
const ACCEPTED_TYPE_ANNOTATIONS = new Set(["Command", "SystemCommand"]);
const FACTORY_CALL_NAMES = new Set(["defineCommand"]);

/**
 * Pure scanner: takes the source code of one file and returns
 * whether it looks like a valid command file. Unit-testable
 * without filesystem access.
 *
 * Heuristic — the file must contain AT LEAST ONE of:
 *
 *   1. `export const X = defineCommand<...>(...)` (call to a
 *      factory whose name is in FACTORY_CALL_NAMES).
 *   2. `export const X: Command<...> = {...}` (type annotation
 *      whose identifier is in ACCEPTED_TYPE_ANNOTATIONS).
 *   3. `export const X: SystemCommand<...> = {...}` (same as
 *      above; SystemCommand is in the set).
 *
 * We DELIBERATELY do not validate the inner shape (input schema
 * present, permission set, etc.) — that's TypeScript's job at
 * compile-time and the bus's job at register-time. The linter
 * exists to catch files that bypass the bus entirely.
 */
export function scanCommandFile(
  sourceText: string,
  fileName: string
): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);

  let factoryCallFound = false;
  let typedDeclarationFound = false;
  let exportedConstSeen = false;

  function visit(node: ts.Node): void {
    // export const X ... — capture the declaration
    if (ts.isVariableStatement(node)) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported === true) {
        for (const decl of node.declarationList.declarations) {
          exportedConstSeen = true;

          // Case (2) and (3): typed declaration
          // `: Command<...>` or `: SystemCommand<...>`
          if (decl.type !== undefined) {
            const typeNode = decl.type;
            if (ts.isTypeReferenceNode(typeNode)) {
              const typeName = typeNode.typeName;
              if (ts.isIdentifier(typeName) && ACCEPTED_TYPE_ANNOTATIONS.has(typeName.text)) {
                typedDeclarationFound = true;
              }
            }
          }

          // Case (1): initializer is a call to defineCommand,
          // possibly with type args.
          const init = decl.initializer;
          if (init !== undefined) {
            // Unwrap a possible `as const` or `satisfies` wrap.
            let expr: ts.Expression = init;
            while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
              expr = expr.expression;
            }
            if (ts.isCallExpression(expr)) {
              const callee = expr.expression;
              if (ts.isIdentifier(callee) && FACTORY_CALL_NAMES.has(callee.text)) {
                factoryCallFound = true;
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);

  if (factoryCallFound || typedDeclarationFound) {
    return { ok: true };
  }
  if (!exportedConstSeen) {
    return {
      ok: false,
      reason: `no \`export const\` declarations found — a command file MUST export a Command/SystemCommand or a defineCommand result`,
    };
  }
  return {
    ok: false,
    reason: `no \`defineCommand(...)\` call and no \`Command<>\`/\`SystemCommand<>\` typed export. Bus enforcement only applies to declarations matching one of those shapes; a free function in a commands/ file is invisible to the bus`,
  };
}

/**
 * Walk every `packages/<pkg>/src/commands/<file>.ts` file
 * (excluding `*.test.ts`, `*.spec.ts`, and `index.ts`) and check
 * each one. Returns the full violation set so the caller decides
 * exit code.
 */
export function checkAllCommandFiles(packagesDir: string): {
  readonly checked: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<Violation>;
} {
  const violations: Violation[] = [];
  const checked: string[] = [];

  const pkgs = readdirSync(packagesDir);
  for (const pkg of pkgs) {
    const cmdDir = join(packagesDir, pkg, "src", "commands");
    let entries: string[];
    try {
      entries = readdirSync(cmdDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (entry.endsWith(".spec.ts")) continue;
      if (COMMAND_FILE_EXCLUDES.has(entry)) continue;
      const filePath = join(cmdDir, entry);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;

      const sourceText = readFileSync(filePath, "utf8");
      const result = scanCommandFile(sourceText, filePath);
      checked.push(filePath);
      if (!result.ok) {
        violations.push({ file: filePath, message: result.reason ?? "unknown reason" });
      }
    }
  }
  return { checked, violations };
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packagesDir = join(root, "packages");
  const { checked, violations } = checkAllCommandFiles(packagesDir);

  if (violations.length > 0) {
    process.stderr.write(`[check-command-files] ${violations.length} violation(s):\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}\n    ${v.message}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`[check-command-files] ok — ${checked.length} command file(s) checked\n`);
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main().catch((err) => {
    process.stderr.write(`[check-command-files] internal error: ${String(err)}\n`);
    process.exit(2);
  });
}
