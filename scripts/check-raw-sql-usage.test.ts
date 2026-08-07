// Tests for scripts/check-raw-sql-usage.ts.
//
// Two layers:
//   1. Pure-function unit tests for `findRawSqlCalls` — does it
//      detect the call forms that matter and ignore the look-alikes
//      (type members, mock keys, comments)?
//   2. A real-workspace sentinel: running the checker over the live
//      repo must report ZERO violations, so the unit suite (not just
//      CI's safety-linters job) trips the moment unapproved raw SQL
//      lands.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkRawSqlUsage, findRawSqlCalls } from "./check-raw-sql-usage.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("findRawSqlCalls", () => {
  it("detects the tagged-template form", () => {
    const src = "const r = await client.$queryRaw`SELECT 1`;";
    const calls = findRawSqlCalls(src, "x.ts");
    expect(calls.map((c) => c.method)).toEqual(["$queryRaw"]);
  });

  it("detects the call form with a type argument", () => {
    const src = "await tx.$executeRaw(Prisma.sql`SELECT set_config('a','b',true)`);";
    const calls = findRawSqlCalls(src, "x.ts");
    expect(calls.map((c) => c.method)).toEqual(["$executeRaw"]);
  });

  it("detects the *Unsafe variants", () => {
    const src = [
      "await db.$queryRawUnsafe('SELECT 1');",
      "await db.$executeRawUnsafe('DELETE FROM t');",
    ].join("\n");
    const calls = findRawSqlCalls(src, "x.ts");
    expect(calls.map((c) => c.method).sort()).toEqual(["$executeRawUnsafe", "$queryRawUnsafe"]);
  });

  it("reports 1-based line numbers", () => {
    const src = ["// header", "", "await client.$queryRaw`SELECT 1`;"].join("\n");
    const calls = findRawSqlCalls(src, "x.ts");
    expect(calls).toEqual([{ method: "$queryRaw", line: 3 }]);
  });

  it("ignores interface/type members named like the raw methods", () => {
    const src = [
      "export interface Tx {",
      "  $executeRaw(template: TemplateStringsArray): Promise<number>;",
      "  readonly $queryRaw: (t: TemplateStringsArray) => Promise<unknown>;",
      "}",
    ].join("\n");
    expect(findRawSqlCalls(src, "x.ts")).toEqual([]);
  });

  it("ignores object-literal mock keys", () => {
    const src = "const mock = { $queryRaw: () => 1, $executeRaw: () => 2 };";
    expect(findRawSqlCalls(src, "x.ts")).toEqual([]);
  });

  it("ignores comments mentioning the methods", () => {
    const src = "// the claim query's $queryRaw is system-context only\nconst x = 1;";
    expect(findRawSqlCalls(src, "x.ts")).toEqual([]);
  });

  it("returns nothing for a file that never mentions raw SQL", () => {
    const src = "export const total = (a: number, b: number): number => a + b;";
    expect(findRawSqlCalls(src, "x.ts")).toEqual([]);
  });

  // The scanner skips parsing files whose text contains none of the
  // method names. That gate must never hide a real call, so pin the
  // riskiest shape: a method reached on a deeply nested receiver, with
  // the name split across lines by the formatter.
  it("still detects a call when the receiver is nested and wrapped", () => {
    const src = ["await ctx.deps.db.client", "  .$executeRawUnsafe('DELETE FROM t');"].join("\n");
    expect(findRawSqlCalls(src, "x.ts").map((c) => c.method)).toEqual(["$executeRawUnsafe"]);
  });
});

describe("checkRawSqlUsage (real workspace sentinel)", () => {
  // Unlike the pure cases above, this one reads every non-test source
  // file under apps/ and packages/ — around 900 of them. What keeps it
  // alive on a contended CI runner is the repo-wide `testTimeout` in
  // vitest.config.ts; deliberately not a literal here, so this test and
  // its sibling sentinels share one budget.
  it("reports zero violations across the live repo", () => {
    const { checked, violations } = checkRawSqlUsage(REPO_ROOT);
    expect(checked).toBeGreaterThan(0);
    expect(
      violations.map((v) => v.file),
      "unapproved raw-SQL call(s) — scope them through the tenancy-enforced client or add to the allowlist in scripts/check-raw-sql-usage.ts with a justification"
    ).toEqual([]);
  });
});
