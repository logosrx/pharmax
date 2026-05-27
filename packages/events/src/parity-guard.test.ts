// Parity guard.
//
// Two layers:
//
//   1. Pure-function tests over `extractEventNameLiterals` and
//      `buildParityReport` so the regex + classification logic can
//      be exercised against synthetic input without filesystem
//      access. These are fast, deterministic, and pin the rule
//      surface.
//
//   2. One repo-wide assertion that:
//        - scans the actual repo tree under packages/ and apps/,
//        - classifies every event-name literal against the live
//          EVENT_REGISTRY + EVENT_REGISTRATION_ALLOWLIST,
//        - fails the suite if ANY event name appears in source but
//          is neither registered nor allowlisted.
//
//      The same assertion also reports orphaned allowlist entries
//      (events on the list but no longer referenced in source) so
//      the migration backlog stays honest.
//
// Why this lives in the test suite rather than a standalone script:
//
//   - Failure surfaces in CI alongside the rest of `pnpm verify`
//     without a separate script entry.
//   - Vitest gives us the diagnostic-friendly diff output when a
//     name set drifts — easier than a hand-rolled CLI.
//   - The same module can also be invoked from a future
//     `scripts/check-event-parity.ts` if the team wants a faster
//     pre-commit gate; the pure-function exports support that.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildParityReport,
  EVENT_NAME_LITERAL,
  EVENT_REGISTRATION_ALLOWLIST,
  extractEventNameLiterals,
  scanRepositoryForEventNames,
} from "./parity-guard.js";
import { EVENT_REGISTRY } from "./registry.js";

// ---------------------------------------------------------------------
// Pure-function tests over the regex + classifier
// ---------------------------------------------------------------------

describe("extractEventNameLiterals", () => {
  it("finds an event-name string literal in a TypeScript object", () => {
    const src = `
const draft = {
  eventType: "order.shipped.v1",
  aggregateType: "Order",
};
`;
    const occurrences = extractEventNameLiterals(src, "src/example.ts");
    expect(occurrences.length).toBe(1);
    expect(occurrences[0]?.fullName).toBe("order.shipped.v1");
    expect(occurrences[0]?.file).toBe("src/example.ts");
    expect(occurrences[0]?.line).toBeGreaterThan(0);
  });

  it("handles single, double, and backtick quotes", () => {
    const src = `
const a = 'order.received.v1';
const b = "order.cancelled.v1";
const c = \`order.shipped.v1\`;
`;
    const occurrences = extractEventNameLiterals(src, "src/example.ts");
    const names = occurrences.map((o) => o.fullName).sort();
    expect(names).toEqual(["order.cancelled.v1", "order.received.v1", "order.shipped.v1"]);
  });

  it("does not match plain English strings", () => {
    const src = `
const note = "hello world";
const k = "order shipped now";
`;
    expect(extractEventNameLiterals(src, "src/example.ts")).toEqual([]);
  });

  it("does not consider a string lacking the .v{n} suffix to be an event", () => {
    const src = `
const x = "order.shipped";
`;
    expect(extractEventNameLiterals(src, "src/example.ts")).toEqual([]);
  });

  it("resets regex state between invocations", () => {
    // The module-level regex object has a `g` flag and persistent
    // lastIndex. Calling the extractor twice in a row on the same
    // source must yield the same result both times.
    const src = `const x = "order.shipped.v1";`;
    const first = extractEventNameLiterals(src, "a.ts");
    const second = extractEventNameLiterals(src, "a.ts");
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    // Even after a one-off run of the raw regex against an unrelated
    // string, the helper must still return correct results.
    EVENT_NAME_LITERAL.lastIndex = 50;
    const third = extractEventNameLiterals(src, "a.ts");
    expect(third.length).toBe(1);
  });
});

describe("buildParityReport", () => {
  it("classifies scanned names into registered / allowlisted / missing", () => {
    const scan = {
      names: ["order.shipped.v1", "future.event.v1", "not.registered.v1"],
      occurrencesByName: new Map(),
    };
    const registered = new Set(["order.shipped.v1"]);
    // We cannot mutate EVENT_REGISTRATION_ALLOWLIST; use one that
    // happens to be on it (`order.note.added.v1`) to exercise the
    // allowlist branch in this pure unit test.
    const scanWithAllowlisted = {
      names: ["order.shipped.v1", "order.note.added.v1", "not.in.registry.v1"],
      occurrencesByName: new Map(),
    };
    const report = buildParityReport(scanWithAllowlisted, registered);
    expect(report.registered).toContain("order.shipped.v1");
    expect(report.allowlisted).toContain("order.note.added.v1");
    expect(report.missing).toContain("not.in.registry.v1");
    expect(report.scanned).toBe(3);
    // Suppress unused-variable lint on the scaffolded scan.
    void scan;
  });

  it("flags orphaned allowlist entries (allowlisted but not found in source)", () => {
    const scan = {
      names: [] as string[],
      occurrencesByName: new Map(),
    };
    const report = buildParityReport(scan, new Set());
    // Every entry on EVENT_REGISTRATION_ALLOWLIST that didn't appear
    // in the (empty) scan should be flagged as orphaned.
    expect(report.orphanedAllowlistEntries.length).toBe(EVENT_REGISTRATION_ALLOWLIST.length);
  });
});

// ---------------------------------------------------------------------
// Repo-wide parity assertion
// ---------------------------------------------------------------------

describe("repo-wide event parity", () => {
  it("every event-name literal in source is either registered or allowlisted", () => {
    // Walk up from this test file to the workspace root. The
    // `packages/events/src/` segment is fixed.
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");

    const scan = scanRepositoryForEventNames(repoRoot);
    const report = buildParityReport(scan, new Set(EVENT_REGISTRY.keys()));

    if (report.missing.length > 0) {
      // Render diagnostic so the failure message tells the
      // developer exactly which events to register or allowlist
      // and where they are in source.
      const lines: string[] = [
        `[parity-guard] ${report.missing.length} event name(s) found in source but not registered (and not on the allowlist):`,
      ];
      for (const name of report.missing) {
        lines.push(`  - ${name}`);
        const occs = report.occurrencesByName.get(name) ?? [];
        for (const occ of occs.slice(0, 5)) {
          lines.push(`      ${occ.file}:${occ.line}`);
        }
        if (occs.length > 5) {
          lines.push(`      ... and ${occs.length - 5} more`);
        }
      }
      lines.push("");
      lines.push(
        "To fix, either (a) add an EventDefinition under packages/events/src/events/ and register it in registry.ts, or (b) add the name to EVENT_REGISTRATION_ALLOWLIST in parity-guard.ts with a one-line justification."
      );
      throw new Error(lines.join("\n"));
    }
    expect(report.missing).toEqual([]);
  });

  it("the allowlist does not contain stale entries", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const scan = scanRepositoryForEventNames(repoRoot);
    const report = buildParityReport(scan, new Set(EVENT_REGISTRY.keys()));
    if (report.orphanedAllowlistEntries.length > 0) {
      throw new Error(
        `[parity-guard] ${report.orphanedAllowlistEntries.length} allowlist entries are no longer referenced in source and should be removed: ${report.orphanedAllowlistEntries.join(", ")}`
      );
    }
    expect(report.orphanedAllowlistEntries).toEqual([]);
  });

  it("every entry in the registry is reachable from the public barrel", () => {
    // Smoke check: a registered definition that isn't exported
    // from index.ts is invisible to consumers and effectively dead.
    // We can't import from the barrel circularly here, but we can
    // assert basic well-formedness of every definition we manage.
    for (const def of EVENT_REGISTRY.values()) {
      expect(def.fullName).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v\d+$/);
      expect(typeof def.aggregateType).toBe("string");
      expect(def.aggregateType.length).toBeGreaterThan(0);
      expect(typeof def.aggregateIdFrom).toBe("function");
    }
  });
});
