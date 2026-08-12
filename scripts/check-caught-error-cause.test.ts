// Tests for scripts/check-caught-error-cause.ts.
//
// Two layers, same shape as check-raw-sql-usage.test.ts:
//   1. Pure-function unit tests for `findUnchainedCaughtErrors` — does
//      it flag the init-object rethrow that drops the caught error,
//      and leave alone the chained, annotated, spread, non-catch and
//      bindingless forms?
//   2. A real-workspace sentinel: the live repo must report ZERO
//      violations, so the unit suite trips the moment a new
//      factory-routed rethrow lands without `cause` or an annotation.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkCaughtErrorCause, findUnchainedCaughtErrors } from "./check-caught-error-cause.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function wrapInCatch(body: string, binding = "err"): string {
  return ["try {", "  work();", `} catch (${binding}) {`, body, "}"].join("\n");
}

describe("findUnchainedCaughtErrors", () => {
  it("flags an init-object rethrow that drops the caught error", () => {
    const src = wrapInCatch(
      `  throw new errors.ConflictError({ code: "X", message: "x", metadata: { a: 1 } });`
    );
    const findings = findUnchainedCaughtErrors(src, "x.ts");
    expect(findings.map((f) => f.className)).toEqual(["ConflictError"]);
  });

  it("flags a bare-identifier error class the same way", () => {
    const src = wrapInCatch(`  throw new ValidationError({ code: "X", message: "x" });`);
    expect(findUnchainedCaughtErrors(src, "x.ts").map((f) => f.className)).toEqual([
      "ValidationError",
    ]);
  });

  it("accepts a rethrow that chains via `cause`", () => {
    const src = wrapInCatch(
      `  throw new errors.ConflictError({ code: "X", message: "x", cause: err });`
    );
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("accepts the shorthand `cause` when the binding is named cause", () => {
    const src = wrapInCatch(
      `  throw new errors.ConflictError({ code: "X", message: "x", cause });`,
      "cause"
    );
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("accepts a spread init, which may carry cause invisibly", () => {
    const src = wrapInCatch(`  throw new errors.InternalError({ ...baseInit, code: "X" });`);
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("accepts an annotated deliberate omission — leading comment", () => {
    const src = wrapInCatch(
      [
        "  // cause-omitted: chain would carry a raw HTTP response across a PHI boundary",
        `  throw new errors.InternalError({ code: "X", message: "x" });`,
      ].join("\n")
    );
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("rejects an annotation with no reason", () => {
    const src = wrapInCatch(
      [
        "  // cause-omitted:",
        `  throw new errors.InternalError({ code: "X", message: "x" });`,
      ].join("\n")
    );
    expect(findUnchainedCaughtErrors(src, "x.ts")).toHaveLength(1);
  });

  it("ignores a bindingless catch — the discard is already visible", () => {
    const src = [
      "try {",
      "  work();",
      "} catch {",
      `  throw new errors.InternalError({ code: "X", message: "x" });`,
      "}",
    ].join("\n");
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("ignores error construction outside any catch", () => {
    const src = `throw new errors.ValidationError({ code: "X", message: "x" });`;
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("ignores non-Error classes and non-object arguments", () => {
    const src = wrapInCatch(
      ['  throw new Response("nope");', `  throw new TypeError("plain, ESLint's turf");`].join("\n")
    );
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([]);
  });

  it("reports 1-based line numbers", () => {
    const src = wrapInCatch(`  throw new errors.ConflictError({ code: "X", message: "x" });`);
    expect(findUnchainedCaughtErrors(src, "x.ts")).toEqual([
      { className: "ConflictError", line: 4 },
    ]);
  });

  it("still flags a construction inside a nested callback in the catch", () => {
    const src = wrapInCatch(
      [
        "  queue(() => {",
        `    throw new errors.InternalError({ code: "X", message: "x" });`,
        "  });",
      ].join("\n")
    );
    expect(findUnchainedCaughtErrors(src, "x.ts")).toHaveLength(1);
  });
});

describe("checkCaughtErrorCause (real workspace sentinel)", () => {
  it("reports zero violations across the live repo", () => {
    const { checked, violations } = checkCaughtErrorCause(REPO_ROOT);
    expect(checked).toBeGreaterThan(0);
    expect(
      violations.map((v) => v.file),
      "factory-routed rethrow(s) dropping the caught error — pass `cause` through the init object or annotate with `// cause-omitted: <reason>`"
    ).toEqual([]);
  });
});
