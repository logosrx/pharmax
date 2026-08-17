// Domain-level test for patient.* event definitions.
//
// PHI invariant: every patient.* event MUST be flagged PHI-BEARING.
//
// The decrypted attributes really do stay in the encrypted columns —
// these payloads carry ids and structural metadata only. That is not
// enough to make them PHI-safe. Every event in this domain is keyed
// on a `patientId`, which is an identifier under 45 CFR
// §164.514(b)(2)(i)(R), and each one asserts something about that
// individual: that they are a patient, that their record was viewed,
// that their allergy profile changed. Ids plus a health fact is PHI.
//
// The invariant is therefore inverted from what it once was, and it
// is domain-wide rather than per-event: nothing in `patient.*` can be
// PHI-safe, because the aggregate itself is the patient. `phiSafe`
// gates partner-webhook egress, so a flip in either direction here is
// a disclosure decision, not a metadata edit.

import { describe, expect, it } from "vitest";

import * as PatientEvents from "./index.js";

const ALL = Object.values(PatientEvents);

describe("patient domain barrel", () => {
  it("7 patient.* events are registered", () => {
    expect(ALL.length).toBe(7);
  });

  it("every patient.* event is owned by `patients`", () => {
    for (const def of ALL) {
      expect(def.owner, `${def.fullName} owner`).toBe("patients");
    }
  });

  it("every patient.* event is PHI-bearing, and so webhook-ineligible", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(false);
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
