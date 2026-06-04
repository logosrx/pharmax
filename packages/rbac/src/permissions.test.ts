// Permission registry tests.
//
// The key invariant: the typed `PERMISSIONS` registry MUST mirror
// the codes seeded into the database by `prisma/seed.ts`. Drift
// causes runtime denies for legitimate users (seed adds a permission;
// registry doesn't list it; code can't reference it) OR runtime
// unknowns (registry references something the seed never inserted;
// guard throws PERMISSION_UNKNOWN at the first call).
//
// This test reads the seed file as a text and extracts the codes —
// importing seed.ts at test time would boot Prisma against a real
// DB. The regex is intentionally strict so a refactor that drops
// the recognized shape will fail the test loudly, prompting an
// update here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSION_CODES,
  PERMISSIONS,
  PERMISSION_METADATA,
  isPermissionCode,
} from "./permissions.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const seedPath = resolve(here, "../../../prisma/seed.ts");
const seedSource = readFileSync(seedPath, "utf8");

function extractSeededCodes(source: string): ReadonlyArray<string> {
  const out: string[] = [];
  // Match the PERMISSIONS literal block:
  //   { code: "orgs.read", description: "..." }
  //   { code: "orders.add_prescription", description: "..." }
  // Underscores are allowed inside compound action names; the leading
  // character is restricted to a letter so a stray `_foo` wouldn't
  // be picked up.
  const re = /\{\s*code:\s*"([a-z][a-z0-9._]+)"\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const code = m[1];
    if (code !== undefined) out.push(code);
  }
  return out;
}

describe("PERMISSIONS registry", () => {
  it("contains the expected number of codes", () => {
    expect(ALL_PERMISSION_CODES).toHaveLength(60);
  });

  it("has unique codes", () => {
    const set = new Set(ALL_PERMISSION_CODES);
    expect(set.size).toBe(ALL_PERMISSION_CODES.length);
  });

  it("registry codes are frozen", () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });

  it("registry mirrors the codes seeded by prisma/seed.ts", () => {
    const seeded: ReadonlyArray<string> = extractSeededCodes(seedSource);
    const registry: ReadonlyArray<string> = [...ALL_PERMISSION_CODES].sort();
    const onlyInSeed = seeded.filter((c) => !registry.includes(c));
    const onlyInRegistry = registry.filter((c) => !seeded.includes(c));
    expect({ onlyInSeed, onlyInRegistry }).toEqual({ onlyInSeed: [], onlyInRegistry: [] });
  });

  it("PERMISSION_METADATA has an entry for every code", () => {
    for (const code of ALL_PERMISSION_CODES) {
      expect(PERMISSION_METADATA[code]).toBeDefined();
      expect(PERMISSION_METADATA[code].description.length).toBeGreaterThan(0);
      expect(PERMISSION_METADATA[code].category.length).toBeGreaterThan(0);
    }
  });

  it("PERMISSION_METADATA has no orphan entries", () => {
    const codes = new Set<string>(ALL_PERMISSION_CODES);
    for (const k of Object.keys(PERMISSION_METADATA)) {
      expect(codes.has(k)).toBe(true);
    }
  });
});

describe("isPermissionCode", () => {
  it("returns true for every registered code", () => {
    for (const code of ALL_PERMISSION_CODES) {
      expect(isPermissionCode(code)).toBe(true);
    }
  });

  it("returns false for unknown strings, undefined, and non-strings", () => {
    expect(isPermissionCode("orders.invent")).toBe(false);
    expect(isPermissionCode("")).toBe(false);
    expect(isPermissionCode(undefined)).toBe(false);
    expect(isPermissionCode(123)).toBe(false);
    expect(isPermissionCode({ code: "orders.read" })).toBe(false);
  });
});
