// The forcing function.
//
// `SCREENING_AXIS_CAPABILITY` claims, per axis, what schema this
// platform has or lacks. This file is what makes a stale claim FAIL
// instead of shipping — the enforcement the module header describes.
//
// Two directions, and the second is the one that matters:
//
//   1. An axis that claims support must have its schema. Mostly
//      redundant with the compiler (a renamed column breaks the query),
//      but it catches a model being dropped and it documents the
//      dependency where a reader will find it.
//   2. An axis that claims the platform CANNOT support it must have its
//      schema ABSENT. This is the one with no compile-time equivalent,
//      and it is the exact failure that happened: `patient_allergy`
//      landing while DRUG_ALLERGY stayed NOT_SUPPORTED_BY_PLATFORM
//      would have broken nothing at all.
//
// The tests below check both against the live schema AND — crucially —
// prove the check FIRES, by feeding `findCapabilityMismatches` a
// synthetic schema in which the missing columns exist. A guard that has
// only ever been observed passing is not known to be a guard.

import { describe, expect, it } from "vitest";

import { CLINICAL_SCREENING_AXES } from "@pharmax/clinical-screening";

import {
  findCapabilityMismatches,
  prismaSchemaReality,
  RECORD_LEVEL_SCREENING_AXES,
  SCREENING_AXIS_CAPABILITY,
  type SchemaReality,
  type ScreeningAxisCapability,
} from "./axis-capability.js";

/** A `SchemaReality` built from a literal, for driving the pure check. */
function fakeReality(schema: Readonly<Record<string, ReadonlyArray<string>>>): SchemaReality {
  return {
    hasModel: (model) => schema[model] !== undefined,
    hasField: (model, field) => (schema[model] ?? []).includes(field),
  };
}

describe("SCREENING_AXIS_CAPABILITY — the declaration matches the schema", () => {
  it("has no mismatches against the live Prisma client", () => {
    // The assertion that fails the day somebody adds structured sig
    // columns and leaves dose screening dark, or removes the allergy
    // tables and leaves the allergy axis claiming it can read them.
    const mismatches = findCapabilityMismatches(SCREENING_AXIS_CAPABILITY, prismaSchemaReality());
    expect(
      mismatches.map((m) => `[${m.kind}] ${m.message}`),
      "screening axis capability no longer matches the schema"
    ).toEqual([]);
  });

  it("declares every axis the engine screens", () => {
    // The Record type already forces this at compile time. Asserted at
    // runtime too because the compile-time guarantee depends on
    // `ScreeningInputAxis` staying derived from
    // `SCREENING_FINDING_KINDS`, and a future refactor could widen it
    // to `string` without anybody noticing.
    for (const axis of CLINICAL_SCREENING_AXES) {
      expect(SCREENING_AXIS_CAPABILITY[axis], `no capability declared for ${axis}`).toBeDefined();
    }
  });

  it("gives every PER_SUBJECT axis a probe, every PER_RECORD axis a mapping, and every claim a rationale", () => {
    for (const axis of CLINICAL_SCREENING_AXES) {
      const capability = SCREENING_AXIS_CAPABILITY[axis];
      expect(capability.rationale.length, `${axis} has an empty rationale`).toBeGreaterThan(0);
      if (capability.kind === "PER_SUBJECT") {
        expect(typeof capability.probe, `${axis} is PER_SUBJECT with no probe`).toBe("function");
      }
      if (capability.kind === "PER_RECORD") {
        expect(
          typeof capability.availabilityForRecord,
          `${axis} is PER_RECORD with no per-record mapping`
        ).toBe("function");
      }
      if (capability.kind === "NOT_SUPPORTED_BY_PLATFORM") {
        // Without this, the forcing function fires with no instruction
        // and the cheapest way to make it stop is to delete it.
        expect(
          capability.whenSchemaArrives.length,
          `${axis} is unsupported with no instruction for when the schema arrives`
        ).toBeGreaterThan(0);
        expect(
          capability.absentSchema.length,
          `${axis} claims to be unsupportable but names no absent schema, so nothing can ever check it`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("names allergy capture as the schema the DRUG_ALLERGY axis depends on", () => {
    // Pins the axis as per-patient rather than platform-unsupported,
    // which is the behavioural change this slice exists to make. If
    // somebody reverts it to NOT_SUPPORTED_BY_PLATFORM while the tables
    // exist, the mismatch test above fails — and this one says which
    // axis regressed.
    const capability = SCREENING_AXIS_CAPABILITY.DRUG_ALLERGY;
    expect(capability.kind).toBe("PER_SUBJECT");
    if (capability.kind !== "PER_SUBJECT") return;
    expect(capability.requiresSchema.map((e) => e.model)).toEqual([
      "PatientAllergy",
      "PatientAllergyHistoryAssertion",
    ]);
  });

  it("names the structured-sig columns as the schema the DOSE_RANGE axis reads", () => {
    // The declaration this whole mechanism forced into existence: the
    // structured-sig migration made the old NOT_SUPPORTED_BY_PLATFORM
    // claim false, and this entry is the honest replacement. Pinned as
    // PER_RECORD — not PER_SUBJECT — because a dose is a fact about
    // one prescription line, and a mixed order must screen its
    // structured line while gapping its legacy one.
    const capability = SCREENING_AXIS_CAPABILITY.DOSE_RANGE;
    expect(capability.kind).toBe("PER_RECORD");
    if (capability.kind !== "PER_RECORD") return;
    expect(capability.requiresSchema).toEqual([
      {
        model: "Prescription",
        fields: ["sigStructureKind", "doseAmount", "doseUnit", "dosesPerDay"],
      },
    ]);
  });

  it("answers AVAILABLE for a structured line and NOT_CAPTURED_FOR_RECORD for a legacy one", () => {
    // NOT_CAPTURED_FOR_RECORD rather than NOT_RECORDED_FOR_SUBJECT is
    // the grading decision of the slice: a prescription is immutable
    // once transcribed, so the acknowledge-tier "obtain it and
    // re-run" instruction cannot be followed by anyone on the order.
    // Recorded informationally instead — never nag, always record.
    const capability = SCREENING_AXIS_CAPABILITY.DOSE_RANGE;
    if (capability.kind !== "PER_RECORD") throw new Error("pinned PER_RECORD above");
    expect(
      capability.availabilityForRecord({
        sigStructureKind: "PRN",
        doseAmount: null,
        doseUnit: null,
        dosesPerDay: null,
      })
    ).toBe("AVAILABLE");
    expect(
      capability.availabilityForRecord({
        sigStructureKind: null,
        doseAmount: null,
        doseUnit: null,
        dosesPerDay: null,
      })
    ).toBe("NOT_CAPTURED_FOR_RECORD");
  });

  it("keeps the PER_RECORD axis list and the declaration in agreement", () => {
    // `run-screen.ts` composes per-line availability from
    // `RecordLevelScreeningAxis`; an axis declared PER_RECORD that the
    // type does not name would be resolved per patient (a compile
    // error today, but this pins the runtime list against the
    // declaration so neither can drift alone).
    const declared = CLINICAL_SCREENING_AXES.filter(
      (axis) => SCREENING_AXIS_CAPABILITY[axis].kind === "PER_RECORD"
    );
    expect(declared).toEqual(RECORD_LEVEL_SCREENING_AXES);
  });
});

describe("findCapabilityMismatches — the guard actually fires", () => {
  const doseColumns = ["doseAmount", "doseUnit", "dosesPerDay"];

  const unsupportedDose: ScreeningAxisCapability = {
    kind: "NOT_SUPPORTED_BY_PLATFORM",
    absentSchema: [{ model: "Prescription", fields: doseColumns }],
    rationale: "no structured sig",
    whenSchemaArrives: "convert to PER_SUBJECT",
  };

  const supportedAllergy: ScreeningAxisCapability = {
    kind: "PER_SUBJECT",
    requiresSchema: [{ model: "PatientAllergy", fields: ["patientId"] }],
    rationale: "allergies are reported, not created",
    probe: async () => true,
  };

  const alwaysProfile: ScreeningAxisCapability = {
    kind: "ALWAYS_AVAILABLE",
    requiresSchema: [{ model: "Prescription", fields: ["patientId"] }],
    rationale: "prescriptions originate here",
  };

  const capabilitiesWith = (
    dose: ScreeningAxisCapability,
    allergy: ScreeningAxisCapability
  ): Readonly<Record<(typeof CLINICAL_SCREENING_AXES)[number], ScreeningAxisCapability>> => ({
    DRUG_DRUG_INTERACTION: alwaysProfile,
    THERAPEUTIC_DUPLICATION: alwaysProfile,
    DRUG_ALLERGY: allergy,
    DOSE_RANGE: dose,
  });

  it("FAILS the moment the schema an unsupported axis says is missing appears", () => {
    // THE TEST THIS WHOLE MECHANISM EXISTS FOR. An engineer ships a
    // structured sig. They change no screening code, because there is
    // no reason to think they should. This is what stops them.
    const mismatches = findCapabilityMismatches(
      capabilitiesWith(unsupportedDose, supportedAllergy),
      fakeReality({
        Prescription: ["patientId", ...doseColumns],
        PatientAllergy: ["patientId"],
      })
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      axis: "DOSE_RANGE",
      kind: "ABSENT_SCHEMA_NOW_PRESENT",
    });
    // The failure has to carry the instruction, or the cheapest fix is
    // to edit the declaration until the noise stops.
    expect(mismatches[0]?.message).toContain("convert to PER_SUBJECT");
  });

  it("stays quiet while the schema is only PARTLY there", () => {
    // Failing halfway through somebody's migration would teach them to
    // silence the check rather than satisfy it. A half-built structured
    // sig cannot supply a dose either, so the claim is still true.
    const mismatches = findCapabilityMismatches(
      capabilitiesWith(unsupportedDose, supportedAllergy),
      fakeReality({
        Prescription: ["patientId", "doseAmount", "doseUnit"],
        PatientAllergy: ["patientId"],
      })
    );
    expect(mismatches).toEqual([]);
  });

  it("FAILS when a supported axis loses the schema it reads", () => {
    const mismatches = findCapabilityMismatches(
      capabilitiesWith(unsupportedDose, supportedAllergy),
      fakeReality({ Prescription: ["patientId"] })
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      axis: "DRUG_ALLERGY",
      kind: "REQUIRED_SCHEMA_MISSING",
    });
    expect(mismatches[0]?.message).toContain("model PatientAllergy does not exist");
  });

  it("FAILS when a supported axis keeps the model but loses a column", () => {
    const mismatches = findCapabilityMismatches(
      capabilitiesWith(unsupportedDose, {
        ...supportedAllergy,
        requiresSchema: [{ model: "PatientAllergy", fields: ["patientId", "clinicalStatus"] }],
      } as ScreeningAxisCapability),
      fakeReality({ Prescription: ["patientId"], PatientAllergy: ["patientId"] })
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain("missing field(s) clinicalStatus");
  });

  it("reports nothing when every claim holds", () => {
    const mismatches = findCapabilityMismatches(
      capabilitiesWith(unsupportedDose, supportedAllergy),
      fakeReality({ Prescription: ["patientId"], PatientAllergy: ["patientId"] })
    );
    expect(mismatches).toEqual([]);
  });
});

describe("prismaSchemaReality", () => {
  it("sees the allergy models and their columns", () => {
    const reality = prismaSchemaReality();
    expect(reality.hasModel("PatientAllergy")).toBe(true);
    expect(reality.hasModel("PatientAllergyHistoryAssertion")).toBe(true);
    expect(reality.hasField("PatientAllergy", "substanceCodeSystem")).toBe(true);
    expect(reality.hasField("PatientAllergyHistoryAssertion", "status")).toBe(true);
  });

  it("sees the structured-sig columns the DOSE_RANGE axis now reads", () => {
    // This assertion used to be the negative half of the live check —
    // pinning the columns ABSENT while the axis claimed
    // NOT_SUPPORTED_BY_PLATFORM. The migration landed, the forcing
    // function fired, and the pin flips with the declaration: if these
    // start failing, the schema LOST the columns a supported axis
    // reads, and the mismatch test above names the regression.
    const reality = prismaSchemaReality();
    expect(reality.hasField("Prescription", "sigStructureKind")).toBe(true);
    expect(reality.hasField("Prescription", "doseAmount")).toBe(true);
    expect(reality.hasField("Prescription", "doseUnit")).toBe(true);
    expect(reality.hasField("Prescription", "dosesPerDay")).toBe(true);
  });

  it("answers false for a model that does not exist rather than throwing", () => {
    const reality = prismaSchemaReality();
    expect(reality.hasModel("NoSuchModel")).toBe(false);
    expect(reality.hasField("NoSuchModel", "whatever")).toBe(false);
  });
});
