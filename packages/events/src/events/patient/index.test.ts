// Domain-level test for patient.* event definitions.
//
// PHI invariant: every patient.* event MUST be flagged PHI-safe.
// Patient PHI lives in encrypted columns; events carry only ids
// and structural metadata. If a future event needs to carry PHI
// (it shouldn't), the flag flip is an explicit, reviewed change
// and this test guards it.

import { describe, expect, it } from "vitest";

import * as PatientEvents from "./index.js";

const ALL = Object.values(PatientEvents);

describe("patient domain barrel", () => {
  it("4 patient.* events are registered", () => {
    expect(ALL.length).toBe(4);
  });

  it("every patient.* event is owned by `patients`", () => {
    for (const def of ALL) {
      expect(def.owner, `${def.fullName} owner`).toBe("patients");
    }
  });

  it("every patient.* event is PHI-free", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(true);
    }
  });

  it("every patient.* event aggregates over `Patient`", () => {
    for (const def of ALL) {
      expect(def.aggregateType, `${def.fullName} aggregateType`).toBe("Patient");
    }
  });

  it("every patient.* event retains for 7y (HIPAA documentation window)", () => {
    for (const def of ALL) {
      expect(def.retention, `${def.fullName} retention`).toBe("7y");
    }
  });
});
