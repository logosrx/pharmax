// scanRepositoryForEventNames — the pure scanner half of the parity
// guard. Extracted so the unit test can drive it against synthetic
// fixtures without touching the real filesystem, and so the
// allowlist enforcement happens at one well-typed seam.
//
// What it does:
//
//   Walks a directory tree, opens every `.ts` / `.tsx` file under
//   `packages/` and `apps/`, and pulls out every string literal
//   that looks like a versioned outbox event name. The regex is
//   the same one `defineEvent` validates against (`EVENT_NAME_REGEX`)
//   so a name shaped like an event name in a source file MUST be
//   either registered or allowlisted.
//
//   For each scanned file the scanner records every match with its
//   absolute path and line number, deduped across the codebase so
//   one event name appearing in 20 files counts as one entry on the
//   "found" list (with the file/line list preserved for diagnostic
//   output).
//
// Why a regex instead of an AST walk:
//
//   The strings we care about appear in three idioms:
//     - `eventType: "order.shipped.v1"` (handlers)
//     - `outboxHandlers = { "order.shipped.v1": ... }` (drainers)
//     - `expect(...).toMatchObject({ eventType: "..." })` (tests)
//
//   An AST walk would need to recognize all three. A regex against
//   string-literal contents catches every one — and the false-
//   positive surface is essentially nil because the regex
//   (`^[a-z_]+(\.[a-z_]+)+\.v\d+$`) is conservative enough that a
//   plain English word can't accidentally match.
//
// PHI rule: this scanner reads source files only. Source files
// never contain PHI; the contents are code. No PHI risk.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Match a versioned event-name string literal anywhere in source. */
export const EVENT_NAME_LITERAL = /["'`]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v\d+)["'`]/g;

/** A single occurrence of an event-name literal in source. */
export interface EventLiteralOccurrence {
  readonly fullName: string;
  readonly file: string;
  readonly line: number;
}

/**
 * Result of scanning a tree. Names are sorted alphabetically so
 * test diagnostics are deterministic.
 */
export interface ScanResult {
  readonly names: ReadonlyArray<string>;
  readonly occurrencesByName: ReadonlyMap<string, ReadonlyArray<EventLiteralOccurrence>>;
}

/** Files / directories the scanner skips wholesale. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "generated",
]);

/** Files where event-name literals are LEGITIMATE without registration. */
const SKIP_FILE_SUFFIXES = [
  // The events package itself defines these names by construction.
  "/packages/events/src/define-event.ts",
  "/packages/events/src/parity-guard.ts",
  "/packages/events/src/parity-guard.test.ts",
  "/packages/events/src/registry.ts",
];

function shouldSkipDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIP_DIRECTORIES.has(name);
}

function shouldScanFile(path: string): boolean {
  if (!(path.endsWith(".ts") || path.endsWith(".tsx"))) return false;
  for (const suffix of SKIP_FILE_SUFFIXES) {
    if (path.endsWith(suffix)) return false;
  }
  // The events package's own definition files declare names by
  // calling `defineEvent({ name: "...", version: N })` — those names
  // ARE the registry by construction and don't need self-check.
  if (path.includes("/packages/events/src/events/")) return false;
  return true;
}

function walk(root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (shouldSkipDir(entry)) continue;
      walk(full, out);
    } else if (st.isFile()) {
      if (shouldScanFile(full)) out.push(full);
    }
  }
}

/**
 * Extract every event-name literal from a single source string.
 * Pure — no filesystem access. Useful for unit testing the regex
 * against synthetic fixtures.
 */
export function extractEventNameLiterals(
  source: string,
  file: string
): ReadonlyArray<EventLiteralOccurrence> {
  const out: EventLiteralOccurrence[] = [];
  // Reset regex state (the `g` flag carries lastIndex between calls
  // when the regex object is reused — we declare it once at module
  // load so this is necessary).
  EVENT_NAME_LITERAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EVENT_NAME_LITERAL.exec(source)) !== null) {
    const fullName = match[1]!;
    const upToMatch = source.slice(0, match.index);
    const line = upToMatch.split("\n").length;
    out.push({ fullName, file, line });
  }
  return out;
}

/**
 * Walk the workspace under `repoRoot` and aggregate every event-
 * name literal found. The result groups occurrences by name so the
 * caller can render a "found in X but not registered" report.
 */
export function scanRepositoryForEventNames(repoRoot: string): ScanResult {
  const files: string[] = [];
  // Two top-level scan roots; matches the workspace layout.
  walk(join(repoRoot, "packages"), files);
  walk(join(repoRoot, "apps"), files);

  const occurrencesByName = new Map<string, EventLiteralOccurrence[]>();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const occ of extractEventNameLiterals(source, file)) {
      const existing = occurrencesByName.get(occ.fullName);
      if (existing === undefined) {
        occurrencesByName.set(occ.fullName, [occ]);
      } else {
        existing.push(occ);
      }
    }
  }
  const names = [...occurrencesByName.keys()].sort();
  // Freeze the per-name occurrence arrays so callers can't mutate
  // the cached scan result by accident.
  const frozen = new Map<string, ReadonlyArray<EventLiteralOccurrence>>();
  for (const [name, occs] of occurrencesByName) {
    frozen.set(name, Object.freeze([...occs]));
  }
  return Object.freeze({ names, occurrencesByName: frozen });
}

// ---------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------
//
// The allowlist is the migration backlog. Events found in source
// that are NOT in `EVENT_REGISTRY` AND NOT on the allowlist fail
// the parity guard.
//
// Two categories of entry are legitimate to keep here:
//
//   1. **Synthetic test fixtures.** Names that exist only inside
//      unit tests for the events/command-bus machinery (so the
//      shape regex matches but no real producer exists). These
//      live here permanently — removing them would require
//      registering names that aren't real events.
//
//   2. **Documented aspirational blockers.** Names that ARE
//      referenced in production source (workflow policy entries,
//      notification template comments, TODOs in security probes)
//      but whose producer command hasn't shipped yet. Each entry
//      has a `BLOCKER:` note explaining the gap and the command
//      that would land it.
//
// Everything else MUST be in `EVENT_REGISTRY`. Once an
// aspirational blocker's producer command ships, register the
// event under `events/<domain>/` and delete its allowlist entry
// in the same PR.
//
// MUST be sorted alphabetically.

export const EVENT_REGISTRATION_ALLOWLIST: ReadonlyArray<string> = Object.freeze([
  // ---- 1. Synthetic test fixtures (permanent) ----
  "a.b.v99", // fixture in packages/events/src/define-event.test.ts
  "bucket.created.v1", // fixture in packages/command-bus/* tests
  "foo.bar.v1", // fixture in packages/events/src/emit.test.ts
  "nope.nada.v9", // fixture in packages/events/src/registry.test.ts
  "order.a.v1", // fixture in packages/command-bus/* tests
  "order.b.v1", // fixture in packages/command-bus/* tests
  "order.ping.v1", // fixture in packages/command-bus/* tests
  "order.shipped.v01", // INVALID-version fixture in packages/events/src/define-event.test.ts
  "order.shipped.v2", // forward-compat placeholder in packages/events/src/compatibility.ts
  "sample.executed.v1", // fixture in packages/command-bus/* tests
  "some.unregistered.event.v1", // fixture in packages/events/src/emit.test.ts

  // ---- 2. Documented aspirational blockers ----
  // BLOCKER: producer command not yet implemented. Schema is
  // ready to land alongside the command; the entry stays on the
  // allowlist until then.
  "clerk.session.created.v1", // BLOCKER: future Clerk webhook handler in @pharmax/security — TODO at packages/security/src/access-review/generate-access-review.ts
  "clerk.session.failed.v1", // BLOCKER: future Clerk webhook handler — TODO at apps/worker/src/security/digest-probes.ts
  "order.note.added.v1", // BLOCKER: future NoteAdded command — referenced in `@pharmax/orders/events.ts` translator (intentionally unmapped permission)
]);

const ALLOWLIST_SET: ReadonlySet<string> = Object.freeze(new Set(EVENT_REGISTRATION_ALLOWLIST));

/** Report shape consumed by the test runner. */
export interface ParityReport {
  readonly scanned: number;
  readonly registered: ReadonlyArray<string>;
  readonly allowlisted: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly orphanedAllowlistEntries: ReadonlyArray<string>;
  readonly occurrencesByName: ReadonlyMap<string, ReadonlyArray<EventLiteralOccurrence>>;
}

/**
 * Classify every event name found in the scan against the
 * registered set and the allowlist. The result is a four-way split
 * the test asserts on:
 *
 *   - `registered`               — found AND in registry.
 *   - `allowlisted`              — found AND on the allowlist.
 *   - `missing`                  — found, NOT in either — this is
 *                                  the failure list.
 *   - `orphanedAllowlistEntries` — on the allowlist but NOT found in
 *                                  source — stale entries to remove.
 */
export function buildParityReport(scan: ScanResult, registered: ReadonlySet<string>): ParityReport {
  const registeredFound: string[] = [];
  const allowlistedFound: string[] = [];
  const missing: string[] = [];
  for (const name of scan.names) {
    if (registered.has(name)) {
      registeredFound.push(name);
    } else if (ALLOWLIST_SET.has(name)) {
      allowlistedFound.push(name);
    } else {
      missing.push(name);
    }
  }
  const orphaned: string[] = [];
  for (const entry of ALLOWLIST_SET) {
    if (!scan.names.includes(entry)) orphaned.push(entry);
  }
  return Object.freeze({
    scanned: scan.names.length,
    registered: Object.freeze(registeredFound),
    allowlisted: Object.freeze(allowlistedFound),
    missing: Object.freeze(missing),
    orphanedAllowlistEntries: Object.freeze(orphaned.sort()),
    occurrencesByName: scan.occurrencesByName,
  });
}
