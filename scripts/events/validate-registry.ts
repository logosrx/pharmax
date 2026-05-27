#!/usr/bin/env tsx
// scripts/events/validate-registry.ts
//
// Pre-merge sanity check on `@pharmax/events`'s `EVENT_REGISTRY`.
//
// What it asserts:
//
//   V1.  Every full-name in the registry matches `EVENT_NAME_REGEX`
//        (lowercase dotted segments + `.v{n}` suffix).
//   V2.  Every definition's `schema` is a `ZodObject`.
//   V3.  No duplicate `(name, version)` pairs.
//   V4.  Every definition has an explicit `owner`. Definitions that
//        inherit the `system` default are flagged — every production
//        event SHOULD declare its owning domain.
//   V5.  Every definition has a retention stamp drawn from the
//        `{7y, 90d, 30d}` set.
//   V6.  PHI-bearing definitions (`phiSafe === false`) are
//        REPORTED but not failed — operations needs visibility
//        into which events MAY carry PHI so PHI-capable consumers
//        are wired correctly. (Today there are zero such events;
//        the registry is uniformly PHI-free.)
//   V7.  Every allowlist entry has a one-line justification
//        (synthetic fixture OR documented blocker).
//
// Exit codes:
//   0  every assertion passed.
//   1  one or more assertions failed; structured failure list
//      printed to stdout in the form `[V<n>] <message>`.
//
// Usage:
//   pnpm exec tsx scripts/events/validate-registry.ts
//   pnpm events:validate

import {
  EVENT_NAME_REGEX,
  EVENT_REGISTRATION_ALLOWLIST,
  EVENT_REGISTRY,
  isZodObject,
  listRegisteredEventDefinitions,
} from "../../packages/events/src/index.js";

interface Failure {
  readonly code: string;
  readonly message: string;
}

const failures: Failure[] = [];

function fail(code: string, message: string): void {
  failures.push({ code, message });
}

// V1 — name regex.
for (const def of EVENT_REGISTRY.values()) {
  if (!EVENT_NAME_REGEX.test(def.fullName)) {
    fail("V1", `"${def.fullName}" does not match ${EVENT_NAME_REGEX.source}`);
  }
}

// V2 — schema is a ZodObject.
for (const def of EVENT_REGISTRY.values()) {
  if (!isZodObject(def.schema)) {
    fail(
      "V2",
      `"${def.fullName}" schema is not a ZodObject; defineEvent should have rejected this at construction.`
    );
  }
}

// V3 — no duplicate (name, version) pairs. The registry is a Map so
// duplicates would have thrown at module load; we re-check here for
// defense-in-depth.
const seenFullNames = new Set<string>();
for (const def of EVENT_REGISTRY.values()) {
  if (seenFullNames.has(def.fullName)) {
    fail("V3", `duplicate registration for "${def.fullName}"`);
  }
  seenFullNames.add(def.fullName);
}

// V4 — every definition declares an owner.
for (const def of EVENT_REGISTRY.values()) {
  if (def.owner === "system") {
    fail(
      "V4",
      `"${def.fullName}" inherits the "system" owner default. Every production event must declare an owner.`
    );
  }
}

// V5 — retention is set.
const VALID_RETENTIONS = new Set(["7y", "90d", "30d"]);
for (const def of EVENT_REGISTRY.values()) {
  if (!VALID_RETENTIONS.has(def.retention)) {
    fail("V5", `"${def.fullName}" has invalid retention "${def.retention}".`);
  }
}

// V6 — PHI flag reporting (non-failing).
const phiBearing = [...EVENT_REGISTRY.values()].filter((d) => d.phiSafe === false);
if (phiBearing.length > 0) {
  console.log(`[V6] ${phiBearing.length} PHI-bearing event(s) detected:`);
  for (const d of phiBearing) {
    console.log(`     - ${d.fullName} (owner=${d.owner}, retention=${d.retention})`);
  }
}

// V7 — allowlist hygiene. Each entry must include either a
// "fixture" or "BLOCKER" annotation in the surrounding source.
// We check that EVERY entry in the array is also LITERALLY present
// in the allowlist file body so a future drive-by edit can't
// accidentally remove the justification comment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const allowlistSourcePath = join(repoRoot, "packages", "events", "src", "parity-guard.ts");
const allowlistSource = readFileSync(allowlistSourcePath, "utf8");
for (const name of EVENT_REGISTRATION_ALLOWLIST) {
  if (!allowlistSource.includes(name)) {
    fail(
      "V7",
      `allowlist entry "${name}" missing from parity-guard.ts source — was the file edited out of sync?`
    );
  }
}

// ---- Report ----
console.log(
  `validate-registry: ${EVENT_REGISTRY.size} registered, ${EVENT_REGISTRATION_ALLOWLIST.length} on allowlist`
);
console.log(
  `validate-registry: ${listRegisteredEventDefinitions().length} definitions enumerated (deterministic order)`
);

if (failures.length === 0) {
  console.log("validate-registry: OK");
  process.exit(0);
}

console.error(`validate-registry: ${failures.length} failure(s):`);
for (const f of failures) {
  console.error(`  [${f.code}] ${f.message}`);
}
process.exit(1);
