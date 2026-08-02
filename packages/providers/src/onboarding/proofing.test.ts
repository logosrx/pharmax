// evaluateProofing / normalizeSurname unit tests — the pure PASS
// bar for automated provider-onboarding identity proofing
// (ADR-0033). All data below is synthetic.

import { describe, expect, it } from "vitest";

import type { CmsNpiSnapshot } from "../npi-sync/diff-engine.js";
import { buildProofingSnapshotJson, evaluateProofing, normalizeSurname } from "./proofing.js";

function snapshot(overrides: Partial<CmsNpiSnapshot> = {}): CmsNpiSnapshot {
  return {
    npi: "1234567893",
    enumerationType: "NPI-1",
    status: "A",
    firstName: "Aisha",
    lastName: "Patel",
    credential: "MD",
    practiceAddress: null,
    lastUpdatedAtCms: new Date("2026-01-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("normalizeSurname", () => {
  it("case-folds, strips accents, and drops punctuation", () => {
    expect(normalizeSurname("O'Brien-Smith")).toBe("obriensmith");
    expect(normalizeSurname("OBRIEN SMITH")).toBe("obriensmith");
    expect(normalizeSurname("Núñez")).toBe("nunez");
    expect(normalizeSurname("St. John")).toBe("stjohn");
  });
});

describe("evaluateProofing", () => {
  it("PASSes an active individual NPI with a matching surname", () => {
    expect(evaluateProofing({ lastName: "Patel" }, snapshot())).toBe("PASS");
  });

  it("PASSes across punctuation/case differences in the surname", () => {
    expect(evaluateProofing({ lastName: "o'brien" }, snapshot({ lastName: "OBrien" }))).toBe(
      "PASS"
    );
  });

  it("NOT_FOUND when CMS has no record", () => {
    expect(evaluateProofing({ lastName: "Patel" }, null)).toBe("NOT_FOUND");
  });

  it("NOT_INDIVIDUAL for NPI-2 (organization) records", () => {
    expect(evaluateProofing({ lastName: "Patel" }, snapshot({ enumerationType: "NPI-2" }))).toBe(
      "NOT_INDIVIDUAL"
    );
  });

  it("DEACTIVATED for CMS status D", () => {
    expect(evaluateProofing({ lastName: "Patel" }, snapshot({ status: "D" }))).toBe("DEACTIVATED");
  });

  it("NAME_MISMATCH when surnames differ", () => {
    expect(evaluateProofing({ lastName: "Nguyen" }, snapshot())).toBe("NAME_MISMATCH");
  });

  it("NAME_MISMATCH when the registry record has no last name", () => {
    expect(evaluateProofing({ lastName: "Patel" }, snapshot({ lastName: null }))).toBe(
      "NAME_MISMATCH"
    );
  });

  it("ordering: enumeration type outranks status outranks name", () => {
    expect(
      evaluateProofing({ lastName: "Nguyen" }, snapshot({ enumerationType: "NPI-2", status: "D" }))
    ).toBe("NOT_INDIVIDUAL");
    expect(evaluateProofing({ lastName: "Nguyen" }, snapshot({ status: "D" }))).toBe("DEACTIVATED");
  });
});

describe("buildProofingSnapshotJson", () => {
  it("serializes the public record subset with ISO dates", () => {
    expect(buildProofingSnapshotJson(snapshot())).toEqual({
      npi: "1234567893",
      enumerationType: "NPI-1",
      status: "A",
      firstName: "Aisha",
      lastName: "Patel",
      credential: "MD",
      lastUpdatedAtCms: "2026-01-15T00:00:00.000Z",
    });
  });
});
