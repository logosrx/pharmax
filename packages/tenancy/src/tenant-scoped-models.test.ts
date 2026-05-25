// Tenant-scope registry vs. generated Prisma client parity.
//
// Every name in `TENANT_SCOPED_MODELS` and `TENANT_EXCLUDED_MODELS`
// MUST correspond to a real Prisma model — a typo here would silently
// disable auto-scoping for that model (catastrophic) or, for excluded
// names, leave a phantom entry in the documentation set that doesn't
// match any real model (confusing during audits).
//
// We assert parity against `Prisma.ModelName` (the union type Prisma
// emits in its dmmf). The check is build-time-equivalent: it runs in
// CI, has no DB requirement, and fails with the offending name.
//
// We also assert coverage: every concrete Prisma model name must
// appear in EITHER the scoped registry OR the excluded set. A new
// model added to the schema without being classified is a hard
// failure here — the next migration cannot land without an explicit
// decision about its tenancy.

import { describe, expect, it } from "vitest";

import { Prisma } from "@pharmax/database";

import { TENANT_EXCLUDED_MODELS, TENANT_SCOPED_MODELS } from "./tenant-scoped-models.js";

const ALL_PRISMA_MODELS: ReadonlySet<string> = new Set(Object.values(Prisma.ModelName));

describe("TENANT_SCOPED_MODELS registry parity", () => {
  it("every registered scoped name matches a real Prisma model", () => {
    const unknown: string[] = [];
    for (const name of TENANT_SCOPED_MODELS.keys()) {
      if (!ALL_PRISMA_MODELS.has(name)) unknown.push(name);
    }
    expect(unknown, `unknown model name(s) in TENANT_SCOPED_MODELS: ${unknown.join(", ")}`).toEqual(
      []
    );
  });

  it("every excluded name matches a real Prisma model", () => {
    const unknown: string[] = [];
    for (const name of TENANT_EXCLUDED_MODELS) {
      if (!ALL_PRISMA_MODELS.has(name)) unknown.push(name);
    }
    expect(
      unknown,
      `unknown model name(s) in TENANT_EXCLUDED_MODELS: ${unknown.join(", ")}`
    ).toEqual([]);
  });

  it("scoped and excluded sets are disjoint", () => {
    const collisions: string[] = [];
    for (const name of TENANT_SCOPED_MODELS.keys()) {
      if (TENANT_EXCLUDED_MODELS.has(name)) collisions.push(name);
    }
    expect(
      collisions,
      `model(s) appearing in BOTH scoped and excluded sets: ${collisions.join(", ")}`
    ).toEqual([]);
  });

  it("every Prisma model is classified (scoped OR excluded) — no orphans", () => {
    const orphans: string[] = [];
    for (const name of ALL_PRISMA_MODELS) {
      const classified = TENANT_SCOPED_MODELS.has(name) || TENANT_EXCLUDED_MODELS.has(name);
      if (!classified) orphans.push(name);
    }
    expect(
      orphans,
      `Prisma model(s) missing from BOTH registries — classify each as scoped or excluded: ${orphans.join(", ")}`
    ).toEqual([]);
  });
});
