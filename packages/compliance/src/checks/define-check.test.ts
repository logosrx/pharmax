import { describe, expect, it } from "vitest";

import { defineCheck } from "./define-check.js";
import { COMPLIANCE_CHECKS, COMPLIANCE_CHECK_REGISTRY, resolveCheck } from "./registry.js";
import type { ComplianceCheckDefinition } from "../types.js";

function validDefinition(
  overrides: Partial<ComplianceCheckDefinition> = {}
): ComplianceCheckDefinition {
  return {
    code: "db.rls.tenant_table_coverage",
    title: "Example",
    description: "Example probe.",
    severity: "HIGH",
    cadence: "DAILY",
    intervalMinutes: 1440,
    controlCodes: ["CC6.1-3"],
    evaluate: async () => [],
    ...overrides,
  };
}

describe("defineCheck — code shape", () => {
  it("accepts dotted lower_snake codes", () => {
    expect(defineCheck(validDefinition()).code).toBe("db.rls.tenant_table_coverage");
  });

  it.each([
    ["no dot", "coverage"],
    ["uppercase", "Db.Rls.Coverage"],
    ["kebab", "db.rls-coverage"],
    ["leading dot", ".db.rls"],
    ["trailing dot", "db.rls."],
    ["leading digit in a segment", "db.1rls"],
    ["empty", ""],
  ])("rejects %s", (_label, code) => {
    expect(() => defineCheck(validDefinition({ code }))).toThrow(/not dotted lower_snake/);
  });
});

describe("defineCheck — control linkage", () => {
  it("rejects a probe that evidences no control", () => {
    expect(() => defineCheck(validDefinition({ controlCodes: [] }))).toThrow(
      /declares no controlCodes/
    );
  });

  it("freezes controlCodes so a caller cannot mutate the registry's copy", () => {
    const mutable = ["CC6.1-3"];
    const definition = defineCheck(validDefinition({ controlCodes: mutable }));

    mutable.push("CC9.9-9");

    expect(definition.controlCodes).toEqual(["CC6.1-3"]);
    expect(Object.isFrozen(definition.controlCodes)).toBe(true);
  });
});

describe("defineCheck — cadence and interval must agree", () => {
  it.each(["CONTINUOUS", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL"] as const)(
    "rejects scheduler-driven cadence %s with a null interval",
    (cadence) => {
      expect(() => defineCheck(validDefinition({ cadence, intervalMinutes: null }))).toThrow(
        /would never receive a nextRunAt/
      );
    }
  );

  it("rejects a non-positive interval", () => {
    expect(() => defineCheck(validDefinition({ intervalMinutes: 0 }))).toThrow(
      /would never receive a nextRunAt/
    );
  });

  it.each(["PER_EVENT", "ON_CHANGE"] as const)(
    "requires event-triggered cadence %s to have a null interval",
    (cadence) => {
      expect(defineCheck(validDefinition({ cadence, intervalMinutes: null })).cadence).toBe(
        cadence
      );
      expect(() => defineCheck(validDefinition({ cadence, intervalMinutes: 60 }))).toThrow(
        /must be null/
      );
    }
  );
});

describe("the shipped registry", () => {
  it("registers every probe under a unique code", () => {
    expect(COMPLIANCE_CHECK_REGISTRY.size).toBe(COMPLIANCE_CHECKS.length);
  });

  it("resolves a known code and returns undefined for an unknown one", () => {
    const first = COMPLIANCE_CHECKS[0]!;
    expect(resolveCheck(first.code)).toBe(first);
    // Undefined rather than a throw: one misconfigured compliance_check
    // row must not stop the rest of the tick from running.
    expect(resolveCheck("does.not.exist")).toBeUndefined();
  });

  it("holds every probe to the same construction rules", () => {
    for (const definition of COMPLIANCE_CHECKS) {
      expect(() => defineCheck(definition)).not.toThrow();
      expect(definition.controlCodes.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(40);
    }
  });
});
