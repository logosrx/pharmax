#!/usr/bin/env tsx
// scripts/check-caught-error-cause.ts
//
// Pre-merge guard. A caught error that is not chained is a diagnosis
// that dies at the catch block.
//
// ESLint 10's `preserve-caught-error` enforces exactly this — for
// BUILT-IN errors. `new Error("...")` inside a catch without
// `{ cause }` is flagged. But this codebase's errors are factory-style
// subclasses of `PharmaxError` taking a single init object:
//
//   } catch (err) {
//     throw new errors.InternalError({
//       code: "X_FAILED",
//       message: "X failed.",
//       // <- the caught `err` is silently dropped; ESLint cannot see it
//     });
//   }
//
// The ESLint rule does not know the init-object convention, so every
// factory-routed rethrow is invisible to it. This script closes that
// gap: inside any catch clause THAT BINDS ITS ERROR, constructing an
// `...Error` class with an init object that has no `cause` property is
// a violation.
//
// DELIBERATE OMISSION IS ALLOWED, BUT MUST SAY SO. There are sound
// reasons to break a cause chain — `PharmaxError.toJSON` documents the
// big one: cause chains can transitively serialize HTTP responses, DB
// rows, and other PHI-adjacent payloads, and some boundaries must not
// carry them. Annotate the statement (or the line above it) with:
//
//   // cause-omitted: <why the chain is deliberately broken>
//
// The reason is mandatory prose for the reviewer, not a magic token.
//
// Catch clauses WITHOUT a binding (`catch {`) are not scanned: the
// author already declared the error irrelevant, and that discard is
// visible in the diff in a way a dropped init property is not.
//
// Test files are not scanned — a test that constructs an error inside
// a catch is asserting on shapes, not losing production diagnostics.
//
// Exit codes:
//   0  Every factory-routed rethrow chains or annotates.
//   1  One or more violations found.
//   2  Internal error (filesystem / parse failure).
//
// Pairs with: eslint `preserve-caught-error` (built-in errors),
// packages/platform-core/src/errors/pharmax-error.ts (the init-object
// contract this script understands).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

interface Violation {
  readonly file: string;
  readonly message: string;
}

interface UnchainedConstruction {
  readonly className: string;
  readonly line: number;
}

/**
 * The opt-out marker. Must be followed by a reason ON THE SAME LINE —
 * `[^\S\n]` is horizontal whitespace only, so a bare `cause-omitted:`
 * cannot borrow the next line's code as its "reason".
 */
const OPT_OUT = /cause-omitted:[^\S\n]*\S/;

// Directories never scanned: third-party, generated, emitted.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "generated", "dist", ".next", "coverage"]);

/** `ValidationError`, `errors.ConflictError`, `securityErrors.Foo…Error`. */
function constructedErrorName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** True when the init object literal carries a `cause` property. */
function initHasCause(init: ts.ObjectLiteralExpression): boolean {
  return init.properties.some((prop) => {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name;
      return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "cause";
    }
    // A spread (`...init`) can carry `cause` from a value this scanner
    // cannot see; assume it does rather than demand an annotation on
    // code that may already be correct.
    return ts.isSpreadAssignment(prop);
  });
}

/**
 * True when the statement enclosing `node` (or the node itself,
 * including its leading trivia) carries a `cause-omitted: <reason>`
 * annotation.
 */
function isAnnotated(node: ts.Node, source: ts.SourceFile): boolean {
  let current: ts.Node = node;
  while (!ts.isStatement(current) && current.parent !== undefined) {
    current = current.parent;
  }
  // getFullText includes leading comment trivia, which is where the
  // annotation lives; also accept a trailing same-line comment by
  // extending to the end of the line.
  const fullText = current.getFullText(source);
  if (OPT_OUT.test(fullText)) return true;
  const end = current.getEnd();
  const lineEnd = source.text.indexOf("\n", end);
  const trailing = source.text.slice(end, lineEnd === -1 ? undefined : lineEnd);
  return OPT_OUT.test(trailing);
}

/**
 * Pure scanner: every `new <…Error>({ … })` lexically inside a
 * binding catch clause whose init object lacks `cause` and whose
 * statement is not annotated. Unit-testable without filesystem access.
 */
export function findUnchainedCaughtErrors(
  sourceText: string,
  fileName: string
): ReadonlyArray<UnchainedConstruction> {
  // Cheap gate: a file with no catch clause has nothing to scan, and
  // parsing ~900 files puts the sentinel test over CI timeouts.
  if (!sourceText.includes("catch")) return [];

  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);
  const findings: UnchainedConstruction[] = [];

  function scanForConstructions(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      const className = constructedErrorName(node.expression);
      const init = node.arguments?.[0];
      if (
        className !== null &&
        className.endsWith("Error") &&
        init !== undefined &&
        ts.isObjectLiteralExpression(init) &&
        !initHasCause(init) &&
        !isAnnotated(node, source)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({ className, line: line + 1 });
      }
    }
    ts.forEachChild(node, scanForConstructions);
  }

  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      scanForConstructions(node.block);
      // Nested catch clauses inside this block are re-visited below;
      // double-reporting is prevented because findings are recorded
      // per NewExpression and a NewExpression is scanned relative to
      // the same statement text either way.
    }
    ts.forEachChild(node, visit);
  }

  visit(source);

  // A NewExpression inside nested catch clauses is discovered once per
  // enclosing binding catch; dedupe by position.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.className}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

export function checkCaughtErrorCause(rootDir: string): {
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
    const sourceText = readFileSync(file, "utf8");
    const findings = findUnchainedCaughtErrors(sourceText, file);
    if (findings.length > 0) {
      const detail = findings.map((f) => `new ${f.className} (line ${f.line})`).join(", ");
      violations.push({
        file: relPath,
        message:
          `constructs an error inside a catch block without chaining the caught error [${detail}]. ` +
          `Pass it through the init object (\`cause: err\`) so the original failure survives to the log, ` +
          `or — if the chain is deliberately broken (e.g. it could carry PHI across a serialization ` +
          `boundary) — annotate the statement with \`// cause-omitted: <reason>\`.`,
      });
    }
  }

  return { checked: files.length, violations };
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { checked, violations } = checkCaughtErrorCause(root);

  if (violations.length > 0) {
    process.stderr.write(`[check-caught-error-cause] ${violations.length} violation(s):\n`);
    for (const v of violations) {
      process.stderr.write(`  ${v.file}\n    ${v.message}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `[check-caught-error-cause] ok — ${checked} file(s) scanned, every factory-routed rethrow chains or annotates\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main().catch((err) => {
    process.stderr.write(`[check-caught-error-cause] internal error: ${String(err)}\n`);
    process.exit(2);
  });
}
