// The patient-scope boundary and the record-state token.
//
// Two properties are pinned here that the flow suite cannot express
// as sharply:
//
//   1. THE BOUNDARY IS EXACTLY THE PER-SUBJECT GAPS. Not "gaps", not
//      "SUBJECT_DATA findings" — three findings carry SUBJECT_DATA at
//      the acknowledge tier today and only ONE of them is a fact
//      about the patient's record. The classification tests below
//      name the other two (knowledge miss, dose-unit mismatch) and
//      pin them OUT, because the day someone "simplifies" the
//      classifier to `remediation === "SUBJECT_DATA"` is the day a
//      per-prescription fact starts being suppressed patient-wide.
//   2. THE TOKEN CANNOT TRAVEL BACKWARDS. Record-then-retract must
//      not hash back to the pre-record value — that ABA hole is
//      precisely the dangerous sequence (ack → data arrives → data
//      entered-in-error → same fingerprint re-arises) the token
//      exists to close.
//
// CLEAN ROOM / PHI: every code below is synthetic.

import { describe, expect, it } from "vitest";

import type { TenantTransactionClient } from "@pharmax/database";

import {
  asPatientRecordGap,
  MAX_RECORD_STATE_ROWS,
  PATIENT_RECORD_GAP_AXIS_BY_CODE,
  patientRecordStateToken,
  PER_SUBJECT_SCREENING_AXES,
  PV1_SCREENING_RECORD_STATE_TOO_LARGE,
  type PatientRecordGapFinding,
} from "./patient-scope.js";
import {
  createScreeningStubs,
  historyTakenNoKnownAllergies,
  screenableStubAllergy,
  type ScreeningStubOptions,
  type ScreeningStubs,
} from "./test-support.js";

const PATIENT_ID = "00000000-0000-4000-8000-0000000000d1";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

function stubTx(options: ScreeningStubOptions = {}): {
  readonly tx: TenantTransactionClient;
  readonly stubs: ScreeningStubs;
} {
  const stubs = createScreeningStubs(() => {}, { patientId: PATIENT_ID, ...options });
  const tx = {
    patientAllergy: stubs.patientAllergy,
    patientAllergyHistoryAssertion: stubs.patientAllergyHistoryAssertion,
  } as unknown as TenantTransactionClient;
  return { tx, stubs };
}

function allergyToken(tx: TenantTransactionClient): Promise<string> {
  return patientRecordStateToken(
    { tx, organizationId: ORG_ID, patientId: PATIENT_ID },
    "DRUG_ALLERGY"
  );
}

describe("asPatientRecordGap — the boundary", () => {
  it("classifies the per-patient allergy-history gap, and names its axis", () => {
    const gap = asPatientRecordGap({
      kind: "SCREENING_GAP",
      code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
      disposition: "REQUIRES_ACKNOWLEDGEMENT",
      fingerprint: "FP-ALLERGY-GAP",
    });
    expect(gap).not.toBeNull();
    expect(gap?.axis).toBe("DRUG_ALLERGY");
    expect(gap?.fingerprint).toBe("FP-ALLERGY-GAP");
  });

  it("refuses every clinical finding, at every disposition", () => {
    for (const [kind, code] of [
      ["DRUG_DRUG_INTERACTION", "SCR_DRUG_INTERACTION"],
      ["DRUG_ALLERGY", "SCR_DRUG_ALLERGY_DIRECT"],
      ["THERAPEUTIC_DUPLICATION", "SCR_DUPLICATE_INGREDIENT"],
      ["DOSE_RANGE", "SCR_DOSE_ABOVE_DAILY_MAXIMUM"],
    ] as const) {
      for (const disposition of ["HARD_STOP", "REQUIRES_ACKNOWLEDGEMENT", "INFORMATIONAL"]) {
        expect(asPatientRecordGap({ kind, code, disposition, fingerprint: "FP" })).toBeNull();
      }
    }
  });

  it("refuses the OTHER SUBJECT_DATA findings — a drug fact and a prescription fact are not patient facts", () => {
    // SCR_KNOWLEDGE_UNAVAILABLE under a PROVISIONED source grades
    // SUBJECT_DATA/MODERATE — but it is a fact about a DRUG CODE
    // missing from reference data, identical for every patient taking
    // the drug. Patient-keying it would mis-file it under a person.
    expect(
      asPatientRecordGap({
        kind: "SCREENING_GAP",
        code: "SCR_KNOWLEDGE_UNAVAILABLE",
        disposition: "REQUIRES_ACKNOWLEDGEMENT",
        fingerprint: "FP-KNOWLEDGE",
      })
    ).toBeNull();
    // SCR_DOSE_UNIT_NOT_COMPARABLE is a fact about ONE prescription;
    // a new prescription is a new dispensing decision.
    expect(
      asPatientRecordGap({
        kind: "SCREENING_GAP",
        code: "SCR_DOSE_UNIT_NOT_COMPARABLE",
        disposition: "REQUIRES_ACKNOWLEDGEMENT",
        fingerprint: "FP-DOSE-UNIT",
      })
    ).toBeNull();
  });

  it("refuses a per-subject gap that does not require acknowledgement", () => {
    // Historical rows exist where this code was raised INFORMATIONAL
    // (the pre-capture NOT_SUPPORTED_BY_PLATFORM grading). Nothing
    // informational may take the patient path — there is no prompt to
    // suppress.
    expect(
      asPatientRecordGap({
        kind: "SCREENING_GAP",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        disposition: "INFORMATIONAL",
        fingerprint: "FP-HISTORICAL",
      })
    ).toBeNull();
  });

  it("cannot be hand-forged: the brand is not constructible outside the module", () => {
    // Compile-time pin. If somebody removes the brand from
    // `PatientRecordGapFinding`, this @ts-expect-error itself becomes
    // an error, and the structural guarantee the gate's parameter
    // type provides is gone — which is exactly what should fail the
    // build.
    // @ts-expect-error — a clinical finding cannot be given the patient-record type by literal construction
    const forged: PatientRecordGapFinding = {
      fingerprint: "FP-FORGED",
      code: "SCR_DRUG_INTERACTION",
      axis: "DRUG_ALLERGY",
    };
    expect(forged.fingerprint).toBe("FP-FORGED");
  });
});

describe("the per-subject axis set", () => {
  it("is exactly DRUG_ALLERGY today, derived from the capability declaration", () => {
    expect(PER_SUBJECT_SCREENING_AXES).toEqual(["DRUG_ALLERGY"]);
    expect([...PATIENT_RECORD_GAP_AXIS_BY_CODE.entries()]).toEqual([
      ["SCR_ALLERGY_INPUT_UNAVAILABLE", "DRUG_ALLERGY"],
    ]);
  });

  it("every PER_SUBJECT axis has a record-state reader — the forcing function for the next axis", async () => {
    // Moving an axis to PER_SUBJECT without teaching
    // `patientRecordStateToken` what "the record changed" means for
    // it must fail HERE, in CI, not as an InternalError in a
    // pharmacy. The derived axis set is what makes this exhaustive by
    // construction.
    const { tx } = stubTx();
    for (const axis of PER_SUBJECT_SCREENING_AXES) {
      await expect(
        patientRecordStateToken({ tx, organizationId: ORG_ID, patientId: PATIENT_ID }, axis)
      ).resolves.toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("the allergy record-state token", () => {
  it("is deterministic for an unchanged record", async () => {
    const { tx } = stubTx({
      allergies: [screenableStubAllergy({ patientId: PATIENT_ID })],
      historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID)],
    });
    expect(await allergyToken(tx)).toBe(await allergyToken(tx));
  });

  it("changes when an allergy is recorded, when it is retracted, and NEVER returns to an earlier value", async () => {
    // The ABA sequence, in full: empty record → allergy recorded →
    // allergy entered-in-error. The record's SCREENABLE content ends
    // where it began (nothing), the gap re-arises with the same
    // fingerprint — and the token must be at its THIRD distinct
    // value, or a pre-record acknowledgement would silently swallow
    // the re-arisen gap.
    const { tx, stubs } = stubTx();
    const empty = await allergyToken(tx);

    stubs.state.allergies.push(
      screenableStubAllergy({ patientId: PATIENT_ID, id: "00000000-0000-4000-8000-00000000a0f1" })
    );
    const recorded = await allergyToken(tx);
    expect(recorded).not.toBe(empty);

    // Retraction is a status amendment that stamps statusChangedAt —
    // the row is never deleted, which is what makes this provable.
    stubs.state.allergies[0] = {
      ...stubs.state.allergies[0]!,
      verificationStatus: "ENTERED_IN_ERROR",
      statusChangedAt: new Date("2026-08-05T10:00:00.000Z"),
    };
    const retracted = await allergyToken(tx);
    expect(retracted).not.toBe(empty);
    expect(retracted).not.toBe(recorded);
  });

  it("changes when a history assertion lands — including one that does not close the gap", async () => {
    // UNABLE_TO_ASSESS leaves the axis gapped, but the record
    // changed: somebody tried to take a history and failed, which the
    // acknowledging pharmacist never saw. Fresh eyes are correct.
    const { tx, stubs } = stubTx();
    const before = await allergyToken(tx);
    stubs.state.historyAssertions.push({
      id: "00000000-0000-4000-8000-00000000b0f2",
      patientId: PATIENT_ID,
      status: "UNABLE_TO_ASSESS",
      assertedAt: new Date("2026-08-05T09:00:00.000Z"),
    });
    expect(await allergyToken(tx)).not.toBe(before);
  });

  it("a status CYCLE never returns the token to an earlier value — statusChangedAt is load-bearing", async () => {
    // The subtle ABA variant: one row amended ENTERED_IN_ERROR and
    // then amended BACK (the retraction was itself an error). The
    // hashed status columns end where they began; only the
    // status-change stamp distinguishes the third state from the
    // first. Drop `statusChangedAt` from the hash and this test is
    // what fails — without it, an acknowledgement recorded at state
    // one would silently satisfy the gate at state three.
    const { tx, stubs } = stubTx({
      allergies: [screenableStubAllergy({ patientId: PATIENT_ID })],
    });
    const initial = await allergyToken(tx);

    stubs.state.allergies[0] = {
      ...stubs.state.allergies[0]!,
      verificationStatus: "ENTERED_IN_ERROR",
      statusChangedAt: new Date("2026-08-05T10:00:00.000Z"),
    };
    const retracted = await allergyToken(tx);
    expect(retracted).not.toBe(initial);

    stubs.state.allergies[0] = {
      ...stubs.state.allergies[0]!,
      verificationStatus: "CONFIRMED",
      statusChangedAt: new Date("2026-08-06T10:00:00.000Z"),
    };
    const reinstated = await allergyToken(tx);
    expect(reinstated).not.toBe(initial);
    expect(reinstated).not.toBe(retracted);
  });

  it("hashes exactly the documented serialization — the golden token", async () => {
    // Pins the byte-level hash input: version prefix, the A-line's
    // field order (id, clinicalStatus, verificationStatus,
    // statusChangedAt), the H-line's (id, status, assertedAt), and
    // the allergies-before-assertions section order. ANY change to
    // the serialization — a dropped input, a reordered field, a new
    // column — must land here, and the correct response is to bump
    // the "allergy-record-state-v1" version prefix (staling every
    // stored token, the safe direction) and update this constant in
    // the same reviewed change.
    const { tx } = stubTx({
      allergies: [screenableStubAllergy({ patientId: PATIENT_ID })],
      historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID)],
    });
    expect(await allergyToken(tx)).toBe(
      "b6a28b66f4b66b20ccf86b3111ab2df4b8c37508dba055265f6befd597ba8099"
    );
  });

  it("refuses a record over the row cap rather than hashing a subset", async () => {
    const { tx, stubs } = stubTx();
    for (let i = 0; i <= MAX_RECORD_STATE_ROWS; i += 1) {
      stubs.state.allergies.push(
        screenableStubAllergy({
          patientId: PATIENT_ID,
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        })
      );
    }
    await expect(allergyToken(tx)).rejects.toMatchObject({
      code: PV1_SCREENING_RECORD_STATE_TOO_LARGE,
    });
  });
});
