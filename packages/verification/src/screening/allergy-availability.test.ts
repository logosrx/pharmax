// What the DRUG_ALLERGY axis answers, per patient — and therefore what
// a pharmacist meets at PV1.
//
// The three states this slice exists to distinguish:
//
//   recorded allergies      → AVAILABLE, records passed, axis screens
//   asserted no allergies   → AVAILABLE, empty list, axis screens clear
//   nobody asked            → NOT_RECORDED_FOR_SUBJECT, acknowledge-tier gap
//
// The middle one is the whole point. Before the assertion table it was
// indistinguishable from the third, and a screening layer that cannot
// tell them apart has to assume the third — which puts an unclosable
// click on every order for every allergy-free patient.
//
// The exclusion cases below (uncoded, food, refuted, resolved) are the
// ones an implementation gets wrong in the direction that reports a
// clean screen, so each is pinned individually.

import { describe, expect, it, vi } from "vitest";

import { hasScreenableAllergyInput, loadScreenableAllergies } from "./allergy-input.js";
import { resolveInputAvailability } from "./axis-capability.js";
import { PV1_SCREENING_ALLERGY_PROFILE_TOO_LARGE } from "./errors.js";
import {
  createScreeningStubs,
  historyTakenNoKnownAllergies,
  screenableStubAllergy,
  type ScreeningStubOptions,
} from "./test-support.js";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000d1";
const OTHER_PATIENT_ID = "00000000-0000-4000-8000-0000000000d2";

function scopeFor(options: ScreeningStubOptions = {}) {
  const stubs = createScreeningStubs(() => {}, { patientId: PATIENT_ID, ...options });
  return {
    scope: { tx: stubs as never, organizationId: ORG_ID, patientId: PATIENT_ID },
    stubs,
  };
}

describe("DRUG_ALLERGY availability — a patient with recorded allergies", () => {
  it("is AVAILABLE and hands the engine the record", async () => {
    const { scope } = scopeFor({ allergies: [screenableStubAllergy()] });

    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(true);

    const availability = await resolveInputAvailability(scope);
    expect(availability.DRUG_ALLERGY).toBe("AVAILABLE");

    const allergies = await loadScreenableAllergies(scope);
    expect(allergies).toEqual([
      {
        recordId: "00000000-0000-4000-8000-00000000a001",
        substanceCode: "TEST-INGREDIENT-1",
        category: "MEDICATION",
        type: "ALLERGY",
        criticality: "LOW",
        verificationStatus: "CONFIRMED",
      },
    ]);
  });

  it("does not need to consult the history assertion at all", async () => {
    // Ordering matters for more than speed: a patient with a recorded
    // allergy AND a stale NO_KNOWN_ALLERGIES assertion must screen
    // against the allergy. Reading the assertion first and trusting it
    // would discard a record somebody took the trouble to enter.
    const { scope, stubs } = scopeFor({
      allergies: [screenableStubAllergy()],
      historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID, new Date("2030-01-01"))],
    });

    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(true);
    expect(stubs.patientAllergyHistoryAssertion.findFirst).not.toHaveBeenCalled();
    await expect(loadScreenableAllergies(scope)).resolves.toHaveLength(1);
  });

  it("passes only the screenable records when the profile is mixed", async () => {
    // No "partially screened" state exists in the engine by design, so
    // the uncoded record is silently absent from the comparison. The
    // console is what carries it to the pharmacist — which is why the
    // PV1 allergy panel is load-bearing rather than decorative.
    const { scope } = scopeFor({
      allergies: [
        screenableStubAllergy(),
        screenableStubAllergy({
          id: "00000000-0000-4000-8000-00000000a002",
          substanceCode: null,
          substanceCodeSystem: "UNCODED",
        }),
      ],
    });

    const allergies = await loadScreenableAllergies(scope);
    expect(allergies.map((a) => a.recordId)).toEqual(["00000000-0000-4000-8000-00000000a001"]);
  });
});

describe("DRUG_ALLERGY availability — a patient asserted to have none", () => {
  it("is AVAILABLE with an empty list, so the axis screens CLEAR", async () => {
    // The state the assertion table was added to make expressible. An
    // empty list here is "we asked and there is nothing", NOT "we did
    // not look" — and because the axis is AVAILABLE, the engine runs the
    // allergy loop (zero times) and raises no gap.
    const { scope } = scopeFor({
      historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID)],
    });

    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(true);
    const availability = await resolveInputAvailability(scope);
    expect(availability.DRUG_ALLERGY).toBe("AVAILABLE");
    await expect(loadScreenableAllergies(scope)).resolves.toEqual([]);
  });

  it("takes the LATEST assertion, so a correction supersedes", async () => {
    const { scope } = scopeFor({
      historyAssertions: [
        historyTakenNoKnownAllergies(PATIENT_ID, new Date("2026-01-01T00:00:00.000Z")),
        {
          id: "00000000-0000-4000-8000-00000000b002",
          patientId: PATIENT_ID,
          status: "UNABLE_TO_ASSESS",
          assertedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
    });

    // The newer UNABLE_TO_ASSESS wins, and does not satisfy the axis.
    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(false);
  });

  it("does NOT accept UNABLE_TO_ASSESS as an empty history", async () => {
    // The single most dangerous line this feature could contain. "We
    // tried and could not find out" is not "we asked and there is
    // nothing", and treating them alike would hand the most reassuring
    // answer to the patient we know least about.
    const { scope } = scopeFor({
      historyAssertions: [
        {
          id: "00000000-0000-4000-8000-00000000b003",
          patientId: PATIENT_ID,
          status: "UNABLE_TO_ASSESS",
          assertedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(false);
    const availability = await resolveInputAvailability(scope);
    expect(availability.DRUG_ALLERGY).toBe("NOT_RECORDED_FOR_SUBJECT");
  });
});

describe("DRUG_ALLERGY availability — a patient nobody has asked", () => {
  it("is NOT_RECORDED_FOR_SUBJECT", async () => {
    const { scope } = scopeFor();
    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(false);
    const availability = await resolveInputAvailability(scope);
    expect(availability.DRUG_ALLERGY).toBe("NOT_RECORDED_FOR_SUBJECT");
  });

  it("is never NOT_SUPPORTED_BY_PLATFORM, because the platform supports it now", async () => {
    // The regression guard for the bug this slice fixes. The old value
    // graded MINOR/INFORMATIONAL and asked nothing of anybody; a revert
    // to it would silence the axis for every patient while the tables
    // sat unused.
    const { scope } = scopeFor();
    const availability = await resolveInputAvailability(scope);
    expect(availability.DRUG_ALLERGY).not.toBe("NOT_SUPPORTED_BY_PLATFORM");
  });
});

describe("DRUG_ALLERGY availability — records the engine cannot use", () => {
  // Each of these is data on file that answers nothing. Counting any of
  // them as AVAILABLE would hand the engine a list it skips entirely and
  // report a clean allergy screen that compared nothing.
  const unusable: ReadonlyArray<[string, Parameters<typeof screenableStubAllergy>[0]]> = [
    [
      "an uncoded substance the engine cannot match",
      {
        substanceCode: null,
        substanceCodeSystem: "UNCODED",
      },
    ],
    ["a FOOD allergy no drug database can answer", { category: "FOOD" }],
    ["an ENVIRONMENT allergy", { category: "ENVIRONMENT" }],
    ["a REFUTED record somebody decided was wrong", { verificationStatus: "REFUTED" }],
    ["a record entered in error", { verificationStatus: "ENTERED_IN_ERROR" }],
    ["a RESOLVED allergy the patient outgrew", { clinicalStatus: "RESOLVED" }],
    ["an INACTIVE record", { clinicalStatus: "INACTIVE" }],
  ];

  for (const [label, overrides] of unusable) {
    it(`treats ${label} as no input at all`, async () => {
      const { scope } = scopeFor({ allergies: [screenableStubAllergy(overrides)] });
      await expect(hasScreenableAllergyInput(scope)).resolves.toBe(false);
      await expect(loadScreenableAllergies(scope)).resolves.toEqual([]);
    });
  }

  it("still reports AVAILABLE for an unusable record IF the history was asserted empty", async () => {
    // The combination worth pinning: a patient with one uncoded allergy
    // AND an asserted-empty history is odd but not contradictory, and
    // the assertion is the statement about completeness. The engine gets
    // an empty list and the axis screens clear; the uncoded record is
    // the console's job.
    const { scope } = scopeFor({
      allergies: [screenableStubAllergy({ substanceCode: null, substanceCodeSystem: "UNCODED" })],
      historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID)],
    });
    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(true);
    await expect(loadScreenableAllergies(scope)).resolves.toEqual([]);
  });
});

describe("DRUG_ALLERGY availability — scoping and limits", () => {
  it("reads only the requested patient's rows", async () => {
    // Tenancy is enforced by the Prisma extension and RLS; this pins the
    // PATIENT filter, which neither of those provides. Screening one
    // patient's prescription against another patient's allergies inside
    // the same tenant would be a clinical error no isolation layer
    // catches.
    const { scope } = scopeFor({
      allergies: [screenableStubAllergy({ patientId: OTHER_PATIENT_ID })],
    });
    await expect(hasScreenableAllergyInput(scope)).resolves.toBe(false);
    await expect(loadScreenableAllergies(scope)).resolves.toEqual([]);
  });

  it("scopes the query by organization AND patient", async () => {
    const record = vi.fn();
    const stubs = createScreeningStubs(record, {
      patientId: PATIENT_ID,
      allergies: [screenableStubAllergy()],
    });
    const scope = { tx: stubs as never, organizationId: ORG_ID, patientId: PATIENT_ID };

    await hasScreenableAllergyInput(scope);

    expect(record).toHaveBeenCalledWith(
      "patientAllergy",
      "findMany",
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          patientId: PATIENT_ID,
          clinicalStatus: "ACTIVE",
        }),
      })
    );
  });

  it("refuses rather than truncating when a patient carries too many allergies", async () => {
    // A `take` would screen against an arbitrary subset and might have
    // skipped the one that mattered — while reporting a clean result
    // either way. Same posture as the medication-profile cap.
    const many = Array.from({ length: 201 }, (_, i) =>
      screenableStubAllergy({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        substanceCode: `TEST-INGREDIENT-${i}`,
      })
    );
    const { scope } = scopeFor({ allergies: many });

    await expect(hasScreenableAllergyInput(scope)).rejects.toMatchObject({
      code: PV1_SCREENING_ALLERGY_PROFILE_TOO_LARGE,
    });
  });
});

describe("resolveInputAvailability — the other three axes", () => {
  it("keeps the profile axes always AVAILABLE and dose unsupported", async () => {
    // The asymmetry that justifies three availability values. A
    // prescription is BORN in Pharmax, so an empty profile is a fact
    // about the patient. An allergy is REPORTED to Pharmax, so an empty
    // list is a fact about our knowledge of them. Those need different
    // answers, and this is where the difference is visible.
    const { scope } = scopeFor();
    const availability = await resolveInputAvailability(scope);

    expect(availability).toEqual({
      DRUG_DRUG_INTERACTION: "AVAILABLE",
      THERAPEUTIC_DUPLICATION: "AVAILABLE",
      DRUG_ALLERGY: "NOT_RECORDED_FOR_SUBJECT",
      DOSE_RANGE: "NOT_SUPPORTED_BY_PLATFORM",
    });
  });

  it("returns a frozen map", async () => {
    const { scope } = scopeFor();
    expect(Object.isFrozen(await resolveInputAvailability(scope))).toBe(true);
  });
});
