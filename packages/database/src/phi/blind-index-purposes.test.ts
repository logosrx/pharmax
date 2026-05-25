import { describe, expect, it } from "vitest";

import {
  ALL_BLIND_INDEX_BINDINGS,
  PATIENT_BLIND_INDEX_BINDINGS,
  PRESCRIPTION_BLIND_INDEX_BINDINGS,
} from "./blind-index-purposes.js";

// The registry is the single source of truth for which `*Bi`
// columns the platform uses. These tests fail loudly if a future
// edit drops a binding (orphans a column) or duplicates a purpose
// (collides search keys across two different normalizers).
describe("blind-index purpose registry", () => {
  it("includes every patient *Bi column", () => {
    const expected = new Set([
      "lastNameBi",
      "firstNameBi",
      "dobBi",
      "dobYearMonthBi",
      "phoneLast10Bi",
      "emailBi",
      "postalCodeBi",
      "mrnBi",
    ]);
    const got = new Set(Object.values(PATIENT_BLIND_INDEX_BINDINGS).map((b) => b.biColumn));
    expect(got).toEqual(expected);
  });

  it("includes every prescription *Bi column", () => {
    const expected = new Set(["rxNumberBi"]);
    const got = new Set(Object.values(PRESCRIPTION_BLIND_INDEX_BINDINGS).map((b) => b.biColumn));
    expect(got).toEqual(expected);
  });

  it("uses '<table>.<column>' purpose format", () => {
    for (const b of ALL_BLIND_INDEX_BINDINGS) {
      expect(b.purpose).toMatch(/^[a-z_][a-z0-9_]*\.[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });

  it("has no duplicate purpose strings", () => {
    const purposes = ALL_BLIND_INDEX_BINDINGS.map((b) => b.purpose);
    expect(new Set(purposes).size).toBe(purposes.length);
  });

  it("has no duplicate (table, biColumn) targets", () => {
    const seen = new Map<string, string>();
    for (const b of ALL_BLIND_INDEX_BINDINGS) {
      const table = b.purpose.split(".")[0]!;
      const key = `${table}.${b.biColumn}`;
      const prior = seen.get(key);
      expect(prior, `duplicate target ${key}`).toBeUndefined();
      seen.set(key, b.purpose);
    }
  });

  it("uses only the documented normalizer values", () => {
    for (const b of ALL_BLIND_INDEX_BINDINGS) {
      expect(["text", "phone", "raw"]).toContain(b.normalizer);
    }
  });

  it("DOB year-month uses a distinct purpose from full DOB", () => {
    expect(PATIENT_BLIND_INDEX_BINDINGS.dateOfBirth.purpose).not.toBe(
      PATIENT_BLIND_INDEX_BINDINGS.dateOfBirthYearMonth.purpose
    );
  });
});
