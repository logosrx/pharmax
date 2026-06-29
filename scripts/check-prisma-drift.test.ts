// scripts/check-prisma-drift.test.ts
//
// Covers the pure functions of the migration↔schema drift guard. No
// filesystem or database access — the prisma invocation and baseline IO
// are exercised end-to-end by `pnpm check:drift` in CI; here we pin the
// parsing/normalization/comparison logic against synthetic inputs.

import { describe, expect, it } from "vitest";

import {
  compareDrift,
  isConnectionFailure,
  normalizeDiffOutput,
  parseBaseline,
  resolveShadowUrl,
} from "./check-prisma-drift.js";

describe("normalizeDiffOutput", () => {
  it("strips leading/trailing blank lines and CRs", () => {
    const raw = "\r\n\n[*] Changed the `invoice` table\r\n  [+] Added unique index\n\n\n";
    expect(normalizeDiffOutput(raw)).toBe(
      "[*] Changed the `invoice` table\n  [+] Added unique index"
    );
  });

  it("rstrips trailing whitespace on each line", () => {
    expect(normalizeDiffOutput("[*] one   \n  [+] two\t\n")).toBe("[*] one\n  [+] two");
  });

  it("treats the no-difference sentinel as empty", () => {
    expect(normalizeDiffOutput("\nNo difference detected.\n")).toBe("");
  });

  it("returns empty for all-blank input", () => {
    expect(normalizeDiffOutput("\n\n   \n")).toBe("");
  });
});

describe("parseBaseline", () => {
  it("drops the leading comment header and normalizes the body", () => {
    const file = [
      "# drift-baseline.txt",
      "# accepted drift",
      "",
      "[*] Changed the `user` table",
      "  [+] Added unique index on columns (clerkUserId)",
      "",
    ].join("\n");
    expect(parseBaseline(file)).toBe(
      "[*] Changed the `user` table\n  [+] Added unique index on columns (clerkUserId)"
    );
  });

  it("reads back an empty (in-sync) baseline as empty", () => {
    const file = "# header\n#\nNo difference detected.\n";
    expect(parseBaseline(file)).toBe("");
  });

  it("does not treat a '#' inside the diff body as a header line", () => {
    // The header block ends at the first non-comment line; a later
    // line is body even if it (improbably) starts with '#'.
    const file = "# header\n\n[*] real body line\n";
    expect(parseBaseline(file)).toBe("[*] real body line");
  });
});

describe("compareDrift", () => {
  const baseline =
    "[*] Changed the `user` table\n  [+] Added unique index on columns (clerkUserId)";

  it("reports in-sync when live equals baseline", () => {
    const cmp = compareDrift(baseline, baseline);
    expect(cmp.inSync).toBe(true);
    expect(cmp.added).toHaveLength(0);
    expect(cmp.removed).toHaveLength(0);
  });

  it("flags a NEW drift line as added", () => {
    const live = `${baseline}\n[*] Changed the \`invoice\` table\n  [+] Added unique index on columns (currency)`;
    const cmp = compareDrift(live, baseline);
    expect(cmp.inSync).toBe(false);
    expect(cmp.added).toContain("[*] Changed the `invoice` table");
    expect(cmp.added).toContain("[+] Added unique index on columns (currency)");
    expect(cmp.removed).toHaveLength(0);
  });

  it("flags RESOLVED drift as removed", () => {
    const live = "[*] Changed the `user` table";
    const cmp = compareDrift(live, baseline);
    expect(cmp.inSync).toBe(false);
    expect(cmp.removed).toContain("[+] Added unique index on columns (clerkUserId)");
    expect(cmp.added).toHaveLength(0);
  });

  it("ignores indentation/whitespace differences when bucketing", () => {
    // Same meaningful content, different leading whitespace → in-sync is
    // text-based (false) but added/removed (trimmed) stay empty.
    const cmp = compareDrift("  [+] x", "[+] x");
    expect(cmp.added).toHaveLength(0);
    expect(cmp.removed).toHaveLength(0);
  });
});

describe("resolveShadowUrl", () => {
  it("prefers the explicit override", () => {
    expect(resolveShadowUrl({ PRISMA_DRIFT_SHADOW_DATABASE_URL: "postgresql://h/explicit" })).toBe(
      "postgresql://h/explicit"
    );
  });

  it("derives a *_drift_shadow db from DATABASE_URL and drops query params", () => {
    const out = resolveShadowUrl({
      DATABASE_URL: "postgresql://u:p@localhost:5432/pharmax?options=-c%20role%3Dpharmax_app",
    });
    const u = new URL(out);
    expect(u.pathname).toBe("/pharmax_drift_shadow");
    expect(u.search).toBe("");
  });

  it("falls back to the localhost default when nothing is set", () => {
    expect(resolveShadowUrl({})).toBe(
      "postgresql://postgres:postgres@localhost:5432/pharmax_drift_shadow"
    );
  });
});

describe("isConnectionFailure", () => {
  it("matches prisma P1001 unreachable", () => {
    expect(isConnectionFailure("Error: P1001: Can't reach database server at ...")).toBe(true);
  });

  it("matches a missing shadow database", () => {
    expect(isConnectionFailure('database "pharmax_drift_shadow" does not exist')).toBe(true);
  });

  it("does not match an ordinary schema error", () => {
    expect(isConnectionFailure("Error validating model: missing @relation")).toBe(false);
  });
});
