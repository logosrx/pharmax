// Registry shape tests.
//
// Asserts that every registered definition is:
//   - keyed under its fullName,
//   - unique (no duplicate fullName),
//   - has a schema whose root is a ZodObject,
//   - and that the listRegisteredEventNames() output is sorted.

import { describe, expect, it } from "vitest";

import { isZodObject } from "./define-event.js";
import { EVENT_REGISTRY, getEventDefinition, listRegisteredEventNames } from "./registry.js";

describe("EVENT_REGISTRY", () => {
  it("is non-empty", () => {
    expect(EVENT_REGISTRY.size).toBeGreaterThan(0);
  });

  it("keys every definition by its fullName", () => {
    for (const [key, def] of EVENT_REGISTRY) {
      expect(key).toBe(def.fullName);
    }
  });

  it("has a ZodObject schema for every definition", () => {
    for (const def of EVENT_REGISTRY.values()) {
      expect(isZodObject(def.schema)).toBe(true);
    }
  });

  it("getEventDefinition resolves registered names and returns undefined for unknown", () => {
    expect(getEventDefinition("patient.registered.v1")?.fullName).toBe("patient.registered.v1");
    expect(getEventDefinition("nope.nada.v9")).toBeUndefined();
  });

  it("listRegisteredEventNames returns a sorted snapshot", () => {
    const names = listRegisteredEventNames();
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
