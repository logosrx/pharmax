// Drift guard: a new order_event-writing command cannot silently escape
// integration coverage.
//
// ## Why a test and not a review convention
//
// The transaction-budget guard exists because review missed four
// `$transaction` call sites; the same failure mode applies here. The
// golden-path suite proves the four-table invariant for the commands it
// dispatches — and proves nothing about a command added next month. A
// reviewer may or may not notice that the new command never appears in
// this package; this test notices every time.
//
// ## How a writer is detected
//
// The bus writes `order_event` in exactly one place
// (`writeOrderEventsInTx` in packages/command-bus/src/define-command.ts),
// and only when a handler's result carries `targetOrderId`. So the
// static marker for "this command writes order_event" is the string
// `targetOrderId` in the command source. That is deliberately a source
// scan rather than an import of each module: importing would execute
// module scope for 100+ commands, and the marker is the field's only
// reason to appear in a handler file.
//
// ## How coverage is detected
//
// A command counts as covered when THIS package dispatches it — the
// suite's own sources are scanned for `executeCommand(SomeCommand`.
// The covered set therefore maintains itself: writing an integration
// test for a command removes it from the uncovered set on the same
// commit, with no second list to update.
//
// The allowlist below is the only hand-maintained piece, and both of its
// failure modes are guarded: a NEW uncovered writer fails the first
// assertion (add coverage, or add it to the allowlist in the same PR and
// defend that in review), and a STALE entry — command deleted, or
// coverage added without pruning — fails the second, so the list can
// only shrink truthfully.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** packages/integration-tests/src -> repository root. */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/**
 * Order_event-writing commands known to lack integration coverage.
 *
 * Keyed as `<package>/<command-file>` (no extension). Every entry is a
 * conscious debt: removing one means integration coverage now exists;
 * adding one must be defended in review. Exception-path commands
 * (cancel, hold, reject, escalate) are the natural next tranche — see
 * the D3 plan's non-goals.
 */
const KNOWN_UNCOVERED_WRITERS: ReadonlySet<string> = new Set([
  "compounding/record-compounding-preparation",
  "fill/reprint-vial-label",
  "orders/add-prescription",
  "orders/cancel-order",
  "orders/dispense-refill",
  "orders/escalate-order-for-sla-breach",
  "orders/place-hold",
  "orders/release-hold",
  "orders/reopen-for-correction",
  "package-capture/resolve-package-photo-match",
  "shipping/escalate-order-to-emergency-bucket",
  "shipping/purchase-shipment-label",
  "shipping/record-shipment-tracking-event",
  "shipping/resolve-order-escalation",
  "typing-assist/accept-typing-suggestion",
  "typing-assist/dismiss-typing-suggestion",
  "typing-assist/request-typing-suggestions",
  "verification/mark-typing-missing-info",
  "verification/reject-final-verification",
  "verification/reject-pv1",
  "verification/resume-typing",
]);

/** `PrintVialLabel` -> `print-vial-label`; `ApprovePV1` -> `approve-pv1`. */
function pascalToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** All `<package>/<file>` command modules whose source writes order_event. */
function findOrderEventWriters(): Set<string> {
  const writers = new Set<string>();
  for (const pkg of listDir(PACKAGES_DIR)) {
    const commandsDir = join(PACKAGES_DIR, pkg, "src", "commands");
    for (const file of listDir(commandsDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(commandsDir, file), "utf8");
      if (source.includes("targetOrderId")) {
        writers.add(`${pkg}/${file.replace(/\.ts$/, "")}`);
      }
    }
  }
  return writers;
}

/** Kebab-case names of every command this suite dispatches. */
function findDispatchedCommands(): Set<string> {
  const dispatched = new Set<string>();
  const scan = (dir: string): void => {
    for (const entry of listDir(dir)) {
      const path = join(dir, entry);
      if (!entry.includes(".")) {
        scan(path);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/executeCommand\(\s*([A-Za-z0-9]+)/g)) {
        const name = match[1];
        if (name !== undefined) dispatched.add(pascalToKebab(name));
      }
    }
  };
  scan(__dirname);
  return dispatched;
}

describe("command integration coverage", () => {
  const writers = findOrderEventWriters();
  const dispatched = findDispatchedCommands();

  const uncovered = [...writers]
    .filter((writer) => {
      const fileName = writer.split("/")[1] ?? "";
      return !dispatched.has(fileName);
    })
    .sort();

  it("finds the command inventory (guards against the scan going blind)", () => {
    // If a refactor moves the commands directories or renames the
    // `targetOrderId` field, both sets collapse toward empty and the
    // assertions below would vacuously pass. Anchor on known ground
    // truth so the scan itself is under test.
    expect(writers.size).toBeGreaterThanOrEqual(30);
    expect(writers).toContain("verification/start-typing");
    expect(dispatched).toContain("start-typing");
    expect(dispatched.size).toBeGreaterThanOrEqual(15);
  });

  it("every order_event-writing command is either integration-covered or explicitly allowlisted", () => {
    const escaped = uncovered.filter((writer) => !KNOWN_UNCOVERED_WRITERS.has(writer));
    expect(
      escaped,
      `New order_event-writing command(s) without integration coverage: ${escaped.join(", ")}.\n` +
        "Either dispatch it from an integration test in packages/integration-tests, or add it to " +
        "KNOWN_UNCOVERED_WRITERS in this file and defend that in review."
    ).toEqual([]);
  });

  it("the allowlist contains no stale entries", () => {
    const stale = [...KNOWN_UNCOVERED_WRITERS].filter((entry) => !uncovered.includes(entry)).sort();
    expect(
      stale,
      `Allowlist entries that are no longer uncovered writers: ${stale.join(", ")}.\n` +
        "The command was deleted, stopped writing order_event, or gained integration coverage — " +
        "remove it from KNOWN_UNCOVERED_WRITERS so the list stays truthful."
    ).toEqual([]);
  });
});
