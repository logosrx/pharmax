#!/usr/bin/env tsx
// scripts/events/migrate-allowlist.ts
//
// "Are we done migrating?" checker.
//
// Walks the repo for event-name literals (using the same scanner
// the parity-guard test runs against), compares the discovered
// set to the current `EVENT_REGISTRY` and `EVENT_REGISTRATION_ALLOWLIST`,
// and prints a structured diff with three buckets:
//
//   - registry_only   — names in the registry but NOT found in any
//                       source file. Usually means a producer was
//                       removed without removing the definition.
//   - legacy_only     — names found in source AND on the allowlist
//                       but NOT in the registry. The migration
//                       backlog.
//   - matched         — names found in source AND in the registry.
//
// Exit codes:
//   0  legacy_only is empty (or contains only documented BLOCKERS
//      / synthetic fixtures, which the allowlist DOES carry).
//   1  registry_only has entries — a dead registry definition
//      must be removed or a producer wired up.
//
// `legacy_only` non-empty does NOT fail the exit code: the
// allowlist captures the expected gap. The script's primary value
// is the structured diff, not pass/fail.
//
// Usage:
//   pnpm exec tsx scripts/events/migrate-allowlist.ts
//   pnpm events:migrate-check

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENT_REGISTRATION_ALLOWLIST,
  EVENT_REGISTRY,
  scanRepositoryForEventNames,
} from "../../packages/events/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const scan = scanRepositoryForEventNames(repoRoot);
const found = new Set(scan.names);
const registered = new Set(EVENT_REGISTRY.keys());
const allowlisted = new Set(EVENT_REGISTRATION_ALLOWLIST);

// Definitions in the registry that have NO occurrence in source.
// These are "dead" — a producer was deleted but the definition
// stayed.
const registryOnly = [...registered].filter((n) => !found.has(n)).sort();

// Names that appear in source but only via the allowlist (not
// registered). These are the migration backlog.
const legacyOnly = [...found].filter((n) => !registered.has(n) && allowlisted.has(n)).sort();

// Names that appear in source, not registered, NOT allowlisted —
// the parity-guard failure surface. Should always be empty at
// HEAD; the parity-guard test catches them in CI.
const unaccounted = [...found].filter((n) => !registered.has(n) && !allowlisted.has(n)).sort();

const matched = [...found].filter((n) => registered.has(n)).sort();

console.log("migrate-allowlist: snapshot of registry parity\n");
console.log(`  scanned source occurrences:     ${found.size}`);
console.log(`  EVENT_REGISTRY size:            ${registered.size}`);
console.log(`  allowlist size:                 ${allowlisted.size}`);
console.log("");
console.log(`  matched (in source ∩ registry): ${matched.length}`);
console.log(`  legacy_only (allowlist):        ${legacyOnly.length}`);
console.log(`  registry_only (dead):           ${registryOnly.length}`);
console.log(`  unaccounted (PARITY FAIL):      ${unaccounted.length}`);
console.log("");

if (unaccounted.length > 0) {
  console.log("UNACCOUNTED — these names are emitted in source but not");
  console.log("registered and not on the allowlist. The parity-guard");
  console.log("test will fail. Register a definition or allowlist with");
  console.log("a justification:");
  for (const n of unaccounted) {
    console.log(`  - ${n}`);
  }
  console.log("");
}

if (registryOnly.length > 0) {
  console.log("REGISTRY_ONLY — these definitions are registered but");
  console.log("never referenced in source. If the producer was removed,");
  console.log("remove the definition too. If the producer is in a");
  console.log("downstream consumer (e.g. apps/worker subscribes via");
  console.log("a constant), that's still a source reference — re-scan");
  console.log("and confirm.");
  for (const n of registryOnly) {
    console.log(`  - ${n}`);
  }
  console.log("");
}

if (legacyOnly.length > 0) {
  console.log("LEGACY_ONLY — these names live in source AND on the");
  console.log("allowlist. The migration is incomplete until each one");
  console.log("either (a) is registered + removed from the allowlist,");
  console.log("or (b) has a BLOCKER comment explaining why it's still");
  console.log("here.");
  for (const n of legacyOnly) {
    console.log(`  - ${n}`);
  }
  console.log("");
}

console.log(
  `migration complete: ${legacyOnly.length === 0 && registryOnly.length === 0 ? "YES" : "NO (see deltas above)"}`
);

// Non-zero exit ONLY for unaccounted or registry_only — the
// allowlist legitimately carries legacy_only.
if (unaccounted.length > 0 || registryOnly.length > 0) {
  process.exit(1);
}
process.exit(0);
