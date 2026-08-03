import { describe, expect, it } from "vitest";

import {
  createInMemoryDrugKnowledgeSource,
  findingsRequiringAcknowledgement,
  hardStopFindings,
  screenPrescription,
  CLINICAL_SCREENING_AXES,
  DEFAULT_SCREENING_POLICY,
  INPUT_UNAVAILABLE_CODE_FOR_AXIS,
  SCREENING_FINDING_KINDS,
  type DrugKnowledge,
  type PrescribedDrug,
  type RecordedAllergy,
  type ScreeningEvaluation,
  type ScreeningFinding,
  type ScreeningFindingCode,
  type ScreeningInputAvailability,
  type ScreeningInputAxis,
  type ScreeningRequest,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// Every code below is synthetic. Real drug names are avoided on
// purpose: they would invite a reader to treat a fixture as clinical
// guidance, and a reviewer to wonder where the pharmacology came from.
// Neither question can be asked of ING_ALFA.
// ---------------------------------------------------------------------------

const DRUGS: Readonly<Record<string, DrugKnowledge>> = {
  // Single ingredient, one therapeutic class, one cross-sensitivity class.
  DRUG_ALFA: {
    ingredientCodes: ["ING_ALFA"],
    therapeuticClassCodes: ["CLASS_ONE"],
    crossSensitivityClassCodes: ["XCLASS_ONE"],
    doseRange: null,
  },
  // Same ingredient as DRUG_ALFA under a different product code — the
  // duplicate-ingredient case.
  DRUG_ALFA_GENERIC: {
    ingredientCodes: ["ING_ALFA"],
    therapeuticClassCodes: ["CLASS_ONE"],
    crossSensitivityClassCodes: ["XCLASS_ONE"],
    doseRange: null,
  },
  // Different ingredient, unrelated class.
  DRUG_BRAVO: {
    ingredientCodes: ["ING_BRAVO"],
    therapeuticClassCodes: ["CLASS_TWO"],
    crossSensitivityClassCodes: [],
    doseRange: null,
  },
  // Different ingredient, SAME class as DRUG_ALFA — class duplication
  // without ingredient duplication.
  DRUG_CHARLIE: {
    ingredientCodes: ["ING_CHARLIE"],
    therapeuticClassCodes: ["CLASS_ONE"],
    crossSensitivityClassCodes: [],
    doseRange: null,
  },
  // Combination product sharing one ingredient with DRUG_ALFA.
  DRUG_COMBO: {
    ingredientCodes: ["ING_ALFA", "ING_BRAVO"],
    therapeuticClassCodes: ["CLASS_ONE", "CLASS_TWO"],
    crossSensitivityClassCodes: [],
    doseRange: null,
  },
  // Carries an absolute contraindication against DRUG_ALFA.
  DRUG_ECHO: {
    ingredientCodes: ["ING_ECHO"],
    therapeuticClassCodes: ["CLASS_THREE"],
    crossSensitivityClassCodes: [],
    doseRange: null,
  },
  DRUG_DOSED: {
    ingredientCodes: ["ING_DELTA"],
    therapeuticClassCodes: ["CLASS_FOUR"],
    crossSensitivityClassCodes: [],
    doseRange: {
      unit: "mg",
      maxSingleDose: 10,
      maxDailyDose: 30,
      minDailyDose: 5,
      citation: "synthetic fixture",
    },
  },
  // Limits chosen so an exactly-correct regimen lands off a binary
  // floating-point boundary. See the tolerance test.
  DRUG_FRACTIONAL: {
    ingredientCodes: ["ING_FOXTROT"],
    therapeuticClassCodes: [],
    crossSensitivityClassCodes: [],
    doseRange: {
      unit: "mg",
      maxSingleDose: 0.1,
      maxDailyDose: 0.3,
      minDailyDose: 0.3,
      citation: null,
    },
  },
};

const KNOWLEDGE = createInMemoryDrugKnowledgeSource({
  drugs: DRUGS,
  allergens: {
    // Not an ingredient of anything here — reaches the candidate only
    // through the shared cross-sensitivity class.
    ALLERGEN_XRAY: { crossSensitivityClassCodes: ["XCLASS_ONE"] },
    // An ingredient that is ALSO cross-sensitivity-classed, so a
    // direct hit and a class hit are both available at once.
    ING_ALFA: { crossSensitivityClassCodes: ["XCLASS_ONE"] },
  },
  interactions: [
    {
      ingredients: ["ING_ALFA", "ING_BRAVO"],
      fact: { severity: "MODERATE", certainty: "PROBABLE", citation: "synthetic fixture" },
    },
    {
      ingredients: ["ING_ALFA", "ING_ECHO"],
      fact: { severity: "CONTRAINDICATED", certainty: "DEFINITE", citation: "synthetic fixture" },
    },
  ],
});

function drug(
  recordId: string,
  drugCode: string,
  dose: PrescribedDrug["dose"] = null
): PrescribedDrug {
  return { recordId, drugCode, dose };
}

function allergy(overrides: Partial<RecordedAllergy> = {}): RecordedAllergy {
  return {
    recordId: "allergy-1",
    substanceCode: "ING_ALFA",
    category: "MEDICATION",
    type: "ALLERGY",
    criticality: "HIGH",
    verificationStatus: "CONFIRMED",
    ...overrides,
  };
}

/**
 * Availability declaration for a caller that can supply everything.
 *
 * Written out rather than derived from `CLINICAL_SCREENING_AXES`, and
 * that is the point: a fifth axis breaks this literal, so the suite
 * cannot keep compiling while quietly asserting the new axis is
 * screened. Tests that want a gap pass `{ ...ALL_INPUTS_AVAILABLE,
 * [axis]: "UNAVAILABLE" }`.
 */
const ALL_INPUTS_AVAILABLE: Readonly<Record<ScreeningInputAxis, ScreeningInputAvailability>> =
  Object.freeze({
    DRUG_DRUG_INTERACTION: "AVAILABLE",
    DRUG_ALLERGY: "AVAILABLE",
    THERAPEUTIC_DUPLICATION: "AVAILABLE",
    DOSE_RANGE: "AVAILABLE",
  });

function withoutAxis(
  axis: ScreeningInputAxis
): Readonly<Record<ScreeningInputAxis, ScreeningInputAvailability>> {
  return { ...ALL_INPUTS_AVAILABLE, [axis]: "UNAVAILABLE" };
}

function screen(overrides: Partial<ScreeningRequest> = {}): ScreeningEvaluation {
  return screenPrescription({
    candidate: drug("line-candidate", "DRUG_ALFA"),
    inputAvailability: ALL_INPUTS_AVAILABLE,
    activeMedications: [],
    allergies: [],
    knowledge: KNOWLEDGE,
    acknowledgedFingerprints: new Set<string>(),
    policy: DEFAULT_SCREENING_POLICY,
    ...overrides,
  });
}

function allFindings(evaluation: ScreeningEvaluation): ReadonlyArray<ScreeningFinding> {
  return evaluation.findings;
}

function codes(evaluation: ScreeningEvaluation): ReadonlyArray<ScreeningFindingCode> {
  return allFindings(evaluation).map((f) => f.code);
}

function requireFinding(
  evaluation: ScreeningEvaluation,
  code: ScreeningFindingCode
): ScreeningFinding {
  const found = allFindings(evaluation).find((f) => f.code === code);
  if (found === undefined) {
    throw new Error(`expected a ${code} finding; got [${codes(evaluation).join(", ")}]`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The clear case
// ---------------------------------------------------------------------------

describe("screenPrescription — nothing to report", () => {
  it("returns CLEAR with an empty findings array", () => {
    const result = screen();
    expect(result.outcome).toBe("CLEAR");
    expect(result.findings).toEqual([]);
  });

  it("is CLEAR against a profile medication with no relationship to the candidate", () => {
    // DRUG_DOSED shares no ingredient, no therapeutic class and no
    // asserted interaction with DRUG_ALFA. A known drug pair that the
    // knowledge source has nothing to say about must produce silence,
    // not a gap.
    const result = screen({ activeMedications: [drug("line-other", "DRUG_DOSED")] });
    expect(result.outcome).toBe("CLEAR");
  });
});

// ---------------------------------------------------------------------------
// Screening gaps — the "we did not check this" reports
// ---------------------------------------------------------------------------

describe("screenPrescription — knowledge gaps", () => {
  it("reports an unknown candidate drug instead of screening clean", () => {
    // The dangerous failure mode: an unrecognised drug code silently
    // passing as "no findings".
    const result = screen({ candidate: drug("line-candidate", "DRUG_UNKNOWN") });
    expect(result.outcome).toBe("ADVISORY");
    expect(codes(result)).toEqual(["SCR_KNOWLEDGE_UNAVAILABLE"]);
    expect(requireFinding(result, "SCR_KNOWLEDGE_UNAVAILABLE").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });

  it("never blocks on a gap", () => {
    // Our reference data being incomplete must not become the
    // patient's problem.
    const result = screen({ candidate: drug("line-candidate", "DRUG_UNKNOWN") });
    expect(hardStopFindings(result)).toEqual([]);
  });

  it("performs no other screening when the candidate is unknown", () => {
    // Without ingredients there is nothing to compare, and reporting a
    // second gap per profile row would bury the one that matters.
    const result = screen({
      candidate: drug("line-candidate", "DRUG_UNKNOWN"),
      activeMedications: [drug("line-a", "DRUG_ALSO_UNKNOWN"), drug("line-b", "DRUG_BRAVO")],
      allergies: [allergy()],
    });
    expect(codes(result)).toEqual(["SCR_KNOWLEDGE_UNAVAILABLE"]);
  });

  it("reports an unknown profile medication when the pair could otherwise be screened", () => {
    const result = screen({
      activeMedications: [drug("line-other", "DRUG_UNKNOWN")],
    });
    const gap = requireFinding(result, "SCR_KNOWLEDGE_UNAVAILABLE");
    expect(gap.triggers).toEqual([
      { source: "PROFILE_MEDICATION", recordId: "line-other", code: "DRUG_UNKNOWN" },
    ]);
  });

  it("merges repeated gaps for the same unknown drug but keeps both record ids", () => {
    const result = screen({
      activeMedications: [drug("line-a", "DRUG_UNKNOWN"), drug("line-b", "DRUG_UNKNOWN")],
    });
    expect(codes(result)).toEqual(["SCR_KNOWLEDGE_UNAVAILABLE"]);
    expect(
      requireFinding(result, "SCR_KNOWLEDGE_UNAVAILABLE").triggers.map((t) => t.recordId)
    ).toEqual(["line-a", "line-b"]);
  });

  it("keeps gaps for different unknown drugs separate", () => {
    const result = screen({
      activeMedications: [drug("line-a", "DRUG_UNKNOWN_ONE"), drug("line-b", "DRUG_UNKNOWN_TWO")],
    });
    expect(allFindings(result)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Drug-allergy screening
// ---------------------------------------------------------------------------

describe("screenPrescription — direct drug allergy", () => {
  it("blocks on a confirmed high-criticality allergy to the exact ingredient", () => {
    // The one clinical situation this engine refuses outright.
    const result = screen({ allergies: [allergy()] });
    expect(result.outcome).toBe("BLOCKED");
    const finding = requireFinding(result, "SCR_DRUG_ALLERGY_DIRECT");
    expect(finding.severity).toBe("CONTRAINDICATED");
    expect(finding.certainty).toBe("DEFINITE");
    expect(finding.disposition).toBe("HARD_STOP");
  });

  it("does not block on an UNCONFIRMED allergy, however critical", () => {
    // An unconfirmed record is usually an intake self-report. Enough
    // to interrupt for; not enough to refuse on.
    const result = screen({
      allergies: [allergy({ verificationStatus: "UNCONFIRMED" })],
    });
    expect(result.outcome).toBe("ADVISORY");
    const finding = requireFinding(result, "SCR_DRUG_ALLERGY_DIRECT");
    expect(finding.severity).toBe("CONTRAINDICATED");
    expect(finding.certainty).toBe("PROBABLE");
    expect(finding.disposition).toBe("REQUIRES_ACKNOWLEDGEMENT");
  });

  it("grades a LOW-criticality allergy as MAJOR, not blocking", () => {
    const result = screen({ allergies: [allergy({ criticality: "LOW" })] });
    expect(requireFinding(result, "SCR_DRUG_ALLERGY_DIRECT").severity).toBe("MAJOR");
    expect(result.outcome).toBe("ADVISORY");
  });

  it("grades an unassessed criticality conservatively but below the blocking tier", () => {
    const result = screen({ allergies: [allergy({ criticality: "UNABLE_TO_ASSESS" })] });
    expect(requireFinding(result, "SCR_DRUG_ALLERGY_DIRECT").severity).toBe("MAJOR");
  });

  it("caps an INTOLERANCE at MODERATE even when recorded as high criticality", () => {
    // Otherwise a documented tolerability problem — nausea — inherits
    // HIGH and hard-stops the dispense.
    const result = screen({
      allergies: [allergy({ type: "INTOLERANCE", criticality: "HIGH" })],
    });
    expect(requireFinding(result, "SCR_DRUG_ALLERGY_DIRECT").severity).toBe("MODERATE");
    expect(result.outcome).toBe("ADVISORY");
  });

  it.each(["REFUTED", "ENTERED_IN_ERROR"] as const)(
    "ignores a %s allergy record entirely",
    (verificationStatus) => {
      // Someone already decided this record was wrong. Screening
      // against it would undo their correction.
      expect(screen({ allergies: [allergy({ verificationStatus })] }).outcome).toBe("CLEAR");
    }
  );

  it.each(["FOOD", "ENVIRONMENT"] as const)(
    "does not screen a %s allergy, and does not report it as a gap either",
    (category) => {
      // A drug knowledge base cannot answer these. Reporting a gap for
      // each would fire on every prescription for the patient forever,
      // which is the failure this engine exists to avoid.
      expect(screen({ allergies: [allergy({ category })] }).outcome).toBe("CLEAR");
    }
  );

  it("screens a BIOLOGIC allergy alongside MEDICATION", () => {
    const result = screen({ allergies: [allergy({ category: "BIOLOGIC" })] });
    expect(codes(result)).toContain("SCR_DRUG_ALLERGY_DIRECT");
  });

  it("carries the allergy record id and the candidate line id for the audit trail", () => {
    const finding = requireFinding(
      screen({ allergies: [allergy({ recordId: "allergy-77" })] }),
      "SCR_DRUG_ALLERGY_DIRECT"
    );
    expect(finding.triggers).toEqual([
      { source: "RECORDED_ALLERGY", recordId: "allergy-77", code: "ING_ALFA" },
      { source: "CANDIDATE_DRUG", recordId: "line-candidate", code: "ING_ALFA" },
    ]);
  });
});

describe("screenPrescription — cross-sensitivity", () => {
  it("reports a class-level match as a distinct, non-blocking finding", () => {
    const result = screen({
      allergies: [allergy({ substanceCode: "ALLERGEN_XRAY" })],
    });
    const finding = requireFinding(result, "SCR_DRUG_ALLERGY_CROSS_SENSITIVITY");
    expect(finding.certainty).toBe("POSSIBLE");
    expect(finding.disposition).toBe("REQUIRES_ACKNOWLEDGEMENT");
    expect(result.outcome).toBe("ADVISORY");
  });

  it("never blocks on cross-sensitivity even at the highest criticality", () => {
    // Class membership is an inference about this patient, never an
    // observation of them — the pharmacist may know they tolerate it.
    const result = screen({
      allergies: [
        allergy({
          substanceCode: "ALLERGEN_XRAY",
          criticality: "HIGH",
          verificationStatus: "CONFIRMED",
        }),
      ],
    });
    expect(hardStopFindings(result)).toEqual([]);
  });

  it("names the shared class in the trigger so the inference is auditable", () => {
    const finding = requireFinding(
      screen({ allergies: [allergy({ substanceCode: "ALLERGEN_XRAY" })] }),
      "SCR_DRUG_ALLERGY_CROSS_SENSITIVITY"
    );
    expect(finding.triggers).toContainEqual({
      source: "CANDIDATE_DRUG",
      recordId: "line-candidate",
      code: "XCLASS_ONE",
    });
  });

  it("suppresses the class match when the same allergy already matched the ingredient exactly", () => {
    // ING_ALFA is seeded both as an ingredient of DRUG_ALFA and as an
    // allergen in XCLASS_ONE, so both paths are available. Reporting
    // both would describe one conversation with the prescriber twice.
    const result = screen({ allergies: [allergy({ substanceCode: "ING_ALFA" })] });
    expect(codes(result)).toEqual(["SCR_DRUG_ALLERGY_DIRECT"]);
  });

  it("stays silent when the allergen is unknown and did not match an ingredient", () => {
    // No cross-sensitivity data available, and the exact comparison
    // needed no lookup and already ran.
    expect(screen({ allergies: [allergy({ substanceCode: "ALLERGEN_UNKNOWN" })] }).outcome).toBe(
      "CLEAR"
    );
  });
});

// ---------------------------------------------------------------------------
// Drug-drug interactions
// ---------------------------------------------------------------------------

describe("screenPrescription — drug-drug interactions", () => {
  it("reports an asserted interaction with the source's own grading", () => {
    const result = screen({ activeMedications: [drug("line-other", "DRUG_BRAVO")] });
    const finding = requireFinding(result, "SCR_DRUG_INTERACTION");
    expect(finding.severity).toBe("MODERATE");
    expect(finding.certainty).toBe("PROBABLE");
    expect(finding.citation).toBe("synthetic fixture");
    expect(finding.triggers).toEqual([
      { source: "CANDIDATE_DRUG", recordId: "line-candidate", code: "ING_ALFA" },
      { source: "PROFILE_MEDICATION", recordId: "line-other", code: "ING_BRAVO" },
    ]);
  });

  it("blocks when the knowledge source grades the interaction CONTRAINDICATED and DEFINITE", () => {
    // The second and last route to a hard stop: an explicit "do not
    // dispense" claim by the licensed authority.
    const result = screen({ activeMedications: [drug("line-other", "DRUG_ECHO")] });
    expect(result.outcome).toBe("BLOCKED");
    expect(requireFinding(result, "SCR_DRUG_INTERACTION").disposition).toBe("HARD_STOP");
  });

  it("finds the interaction whichever drug is the one being dispensed", () => {
    const dispensingAlfa = screen({
      candidate: drug("line-1", "DRUG_ALFA"),
      activeMedications: [drug("line-2", "DRUG_BRAVO")],
    });
    const dispensingBravo = screen({
      candidate: drug("line-2", "DRUG_BRAVO"),
      activeMedications: [drug("line-1", "DRUG_ALFA")],
    });
    expect(codes(dispensingAlfa)).toContain("SCR_DRUG_INTERACTION");
    expect(codes(dispensingBravo)).toContain("SCR_DRUG_INTERACTION");
    // Same clinical situation, therefore the same acknowledgement key.
    expect(requireFinding(dispensingBravo, "SCR_DRUG_INTERACTION").fingerprint).toBe(
      requireFinding(dispensingAlfa, "SCR_DRUG_INTERACTION").fingerprint
    );
  });

  it("screens every ingredient of a combination product", () => {
    // DRUG_COMBO contributes ING_BRAVO, which interacts with the
    // candidate's ING_ALFA.
    const result = screen({ activeMedications: [drug("line-other", "DRUG_COMBO")] });
    expect(codes(result)).toContain("SCR_DRUG_INTERACTION");
  });

  it("does not ask whether an ingredient interacts with itself", () => {
    // Same ingredient on both sides is duplication, and is reported as
    // exactly that.
    const result = screen({ activeMedications: [drug("line-other", "DRUG_ALFA_GENERIC")] });
    expect(codes(result)).not.toContain("SCR_DRUG_INTERACTION");
  });

  it("merges one interaction arising from two profile rows, keeping both record ids", () => {
    const result = screen({
      activeMedications: [drug("line-a", "DRUG_BRAVO"), drug("line-b", "DRUG_BRAVO")],
    });
    const finding = requireFinding(result, "SCR_DRUG_INTERACTION");
    expect(allFindings(result).filter((f) => f.code === "SCR_DRUG_INTERACTION")).toHaveLength(1);
    expect(finding.triggers.map((t) => t.recordId).sort()).toEqual([
      "line-a",
      "line-b",
      "line-candidate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Therapeutic duplication
// ---------------------------------------------------------------------------

describe("screenPrescription — therapeutic duplication", () => {
  it("reports a duplicated ingredient as MAJOR but never blocks on it", () => {
    // Overlapping the same ingredient is standard during a cross-taper
    // or a scheduled-plus-PRN regimen; the intent is on the sig, which
    // the engine cannot read.
    const result = screen({ activeMedications: [drug("line-other", "DRUG_ALFA_GENERIC")] });
    const finding = requireFinding(result, "SCR_DUPLICATE_INGREDIENT");
    expect(finding.severity).toBe("MAJOR");
    expect(finding.certainty).toBe("DEFINITE");
    expect(finding.disposition).toBe("REQUIRES_ACKNOWLEDGEMENT");
    expect(result.outcome).toBe("ADVISORY");
  });

  it("reports a shared therapeutic class as a weaker, inferential finding", () => {
    const result = screen({ activeMedications: [drug("line-other", "DRUG_CHARLIE")] });
    const finding = requireFinding(result, "SCR_DUPLICATE_THERAPEUTIC_CLASS");
    expect(finding.severity).toBe("MODERATE");
    expect(finding.certainty).toBe("POSSIBLE");
  });

  it("suppresses the class duplication that a shared ingredient necessarily implies", () => {
    // DRUG_ALFA_GENERIC shares both ING_ALFA and CLASS_ONE. One
    // clinical situation, one finding.
    const result = screen({ activeMedications: [drug("line-other", "DRUG_ALFA_GENERIC")] });
    expect(codes(result)).not.toContain("SCR_DUPLICATE_THERAPEUTIC_CLASS");
  });

  it("reports a partial overlap with a combination product", () => {
    const result = screen({ activeMedications: [drug("line-other", "DRUG_COMBO")] });
    const finding = requireFinding(result, "SCR_DUPLICATE_INGREDIENT");
    expect(finding.triggers.map((t) => t.code)).toEqual(["ING_ALFA", "ING_ALFA"]);
  });

  it("skips a profile row that IS the candidate line", () => {
    // A refill re-screened against a profile that already contains it
    // would otherwise report the drug as duplicating itself.
    const result = screen({
      candidate: drug("line-candidate", "DRUG_ALFA"),
      activeMedications: [drug("line-candidate", "DRUG_ALFA")],
    });
    expect(result.outcome).toBe("CLEAR");
  });

  it("still reports a genuine duplicate under a different line id", () => {
    // Guard on the skip above: it must key on the record id, not on
    // the drug code.
    const result = screen({
      candidate: drug("line-candidate", "DRUG_ALFA"),
      activeMedications: [drug("line-earlier", "DRUG_ALFA")],
    });
    expect(codes(result)).toContain("SCR_DUPLICATE_INGREDIENT");
  });
});

// ---------------------------------------------------------------------------
// Dose range
// ---------------------------------------------------------------------------

describe("screenPrescription — dose range", () => {
  function dosed(amount: number, dosesPerDay: number, unit = "mg"): ScreeningEvaluation {
    return screen({
      candidate: drug("line-candidate", "DRUG_DOSED", { amount, unit, dosesPerDay }),
    });
  }

  it("reports a single dose above the known maximum", () => {
    const finding = requireFinding(dosed(11, 1), "SCR_DOSE_ABOVE_SINGLE_MAXIMUM");
    expect(finding.severity).toBe("MAJOR");
    expect(finding.citation).toBe("synthetic fixture");
  });

  it("permits a single dose exactly at the maximum", () => {
    expect(codes(dosed(10, 1))).not.toContain("SCR_DOSE_ABOVE_SINGLE_MAXIMUM");
  });

  it("reports a daily total above the known maximum", () => {
    // 10mg is a legal single dose; four of them a day is not.
    expect(codes(dosed(10, 4))).toContain("SCR_DOSE_ABOVE_DAILY_MAXIMUM");
    expect(codes(dosed(10, 3))).not.toContain("SCR_DOSE_ABOVE_DAILY_MAXIMUM");
  });

  it("never blocks on a dose finding, however far above the range", () => {
    // A dosing range is a population statement. Oncology, palliative
    // care and opioid tolerance all exceed it correctly.
    const result = dosed(1000, 4);
    expect(hardStopFindings(result)).toEqual([]);
    expect(result.outcome).toBe("ADVISORY");
  });

  it("treats a sub-therapeutic daily total as informational only", () => {
    // Titration and renal adjustment start below the range often
    // enough that interrupting would cost more attention than it saves.
    const result = dosed(2, 1);
    const finding = requireFinding(result, "SCR_DOSE_BELOW_DAILY_MINIMUM");
    expect(finding.severity).toBe("MINOR");
    expect(finding.disposition).toBe("INFORMATIONAL");
    expect(findingsRequiringAcknowledgement(result)).toEqual([]);
  });

  it("does not fire on a regimen that is exactly at the limit in decimal but not in binary", () => {
    // 0.1 x 3 is 0.30000000000000004. Comparing strictly would report
    // a MAJOR finding on a correct prescription — the most expensive
    // kind of false positive there is.
    const result = screen({
      candidate: drug("line-candidate", "DRUG_FRACTIONAL", {
        amount: 0.1,
        unit: "mg",
        dosesPerDay: 3,
      }),
    });
    expect(result.outcome).toBe("CLEAR");
  });

  it("reports a unit mismatch as a gap and screens no dose at all", () => {
    // No conversion is attempted: a wrong mg/mcg factor buried in a
    // safety check is worse than no check.
    const result = dosed(5000, 1, "mcg");
    expect(codes(result)).toEqual(["SCR_DOSE_UNIT_NOT_COMPARABLE"]);
    expect(requireFinding(result, "SCR_DOSE_UNIT_NOT_COMPARABLE").kind).toBe("SCREENING_GAP");
  });

  it("skips daily arithmetic when there is no schedule, but still checks the single dose", () => {
    // dosesPerDay 0 is a PRN sig with no defined frequency. Inventing
    // a daily total of zero would report every PRN as sub-therapeutic.
    const result = dosed(50, 0);
    expect(codes(result)).toEqual(["SCR_DOSE_ABOVE_SINGLE_MAXIMUM"]);
  });

  it("screens nothing when the prescription carries no dose", () => {
    expect(screen({ candidate: drug("line-candidate", "DRUG_DOSED") }).outcome).toBe("CLEAR");
  });

  it("screens nothing when the knowledge source has no dosing envelope", () => {
    const result = screen({
      candidate: drug("line-candidate", "DRUG_ALFA", { amount: 9999, unit: "mg", dosesPerDay: 9 }),
    });
    expect(result.outcome).toBe("CLEAR");
  });
});

// ---------------------------------------------------------------------------
// Acknowledgement carry-forward
// ---------------------------------------------------------------------------

describe("screenPrescription — prior acknowledgements", () => {
  it("downgrades a previously acknowledged finding to informational", () => {
    const first = screen({ activeMedications: [drug("line-other", "DRUG_BRAVO")] });
    const fingerprint = requireFinding(first, "SCR_DRUG_INTERACTION").fingerprint;

    const second = screen({
      activeMedications: [drug("line-other", "DRUG_BRAVO")],
      acknowledgedFingerprints: new Set([fingerprint]),
    });
    expect(requireFinding(second, "SCR_DRUG_INTERACTION").disposition).toBe("INFORMATIONAL");
    expect(findingsRequiringAcknowledgement(second)).toEqual([]);
    // Still reported — downgraded, not hidden.
    expect(second.outcome).toBe("ADVISORY");
  });

  it("does not downgrade a hard stop", () => {
    // An unoverridable finding that a prior acknowledgement could
    // switch off would not be unoverridable, only slower.
    const first = screen({ allergies: [allergy()] });
    const fingerprint = requireFinding(first, "SCR_DRUG_ALLERGY_DIRECT").fingerprint;

    const second = screen({
      allergies: [allergy()],
      acknowledgedFingerprints: new Set([fingerprint]),
    });
    expect(second.outcome).toBe("BLOCKED");
    expect(requireFinding(second, "SCR_DRUG_ALLERGY_DIRECT").disposition).toBe("HARD_STOP");
  });

  it("carries an acknowledgement across a refill under a new line id", () => {
    const january = screen({
      candidate: drug("line-january", "DRUG_ALFA"),
      activeMedications: [drug("line-other", "DRUG_BRAVO")],
    });
    const acknowledged = new Set([requireFinding(january, "SCR_DRUG_INTERACTION").fingerprint]);

    const february = screen({
      candidate: drug("line-february", "DRUG_ALFA"),
      activeMedications: [drug("line-other", "DRUG_BRAVO")],
      acknowledgedFingerprints: acknowledged,
    });
    expect(requireFinding(february, "SCR_DRUG_INTERACTION").disposition).toBe("INFORMATIONAL");
  });

  it("ignores an acknowledgement for an unrelated situation", () => {
    const result = screen({
      activeMedications: [drug("line-other", "DRUG_BRAVO")],
      acknowledgedFingerprints: new Set(["SCR_DRUG_INTERACTION|ING_ZULU+ING_YANKEE"]),
    });
    expect(requireFinding(result, "SCR_DRUG_INTERACTION").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("screenPrescription — reporting floor", () => {
  it("reports the informational tier by default", () => {
    const result = screen({
      candidate: drug("line-candidate", "DRUG_DOSED", { amount: 2, unit: "mg", dosesPerDay: 1 }),
    });
    expect(codes(result)).toContain("SCR_DOSE_BELOW_DAILY_MINIMUM");
  });

  it("drops findings below the configured floor", () => {
    const result = screen({
      candidate: drug("line-candidate", "DRUG_DOSED", { amount: 2, unit: "mg", dosesPerDay: 1 }),
      policy: { minimumReportedSeverity: "MODERATE" },
    });
    expect(result.outcome).toBe("CLEAR");
  });

  it("keeps a blocking finding at the highest possible floor", () => {
    const result = screen({
      allergies: [allergy()],
      policy: { minimumReportedSeverity: "CONTRAINDICATED" },
    });
    expect(result.outcome).toBe("BLOCKED");
  });

  it("silences the acknowledge tier at the highest floor, which is why raising it is discouraged", () => {
    // Pinned deliberately: the knob CAN switch off the part of the
    // engine that changes decisions, and a reader should see that.
    const result = screen({
      activeMedications: [drug("line-other", "DRUG_ALFA_GENERIC")],
      policy: { minimumReportedSeverity: "CONTRAINDICATED" },
    });
    expect(result.outcome).toBe("CLEAR");
  });
});

// ---------------------------------------------------------------------------
// Aggregation, ordering, and the audit payload
// ---------------------------------------------------------------------------

describe("screenPrescription — completeness and ordering", () => {
  const busy: Partial<ScreeningRequest> = {
    candidate: drug("line-candidate", "DRUG_DOSED", { amount: 50, unit: "mg", dosesPerDay: 4 }),
    activeMedications: [drug("line-other", "DRUG_UNKNOWN")],
    allergies: [allergy({ substanceCode: "ING_DELTA", criticality: "LOW" })],
  };

  it("returns every finding at once rather than stopping at the first", () => {
    const result = screen(busy);
    expect(new Set(codes(result))).toEqual(
      new Set([
        "SCR_DRUG_ALLERGY_DIRECT",
        "SCR_DOSE_ABOVE_SINGLE_MAXIMUM",
        "SCR_DOSE_ABOVE_DAILY_MAXIMUM",
        "SCR_KNOWLEDGE_UNAVAILABLE",
      ])
    );
  });

  it("orders the most severe finding first", () => {
    const result = screen(busy);
    const severities = allFindings(result).map((f) => f.severity);
    expect(severities[0]).toBe("MAJOR");
    expect(severities[severities.length - 1]).toBe("MODERATE");
  });

  it("is deterministic across repeated evaluation of the same facts", () => {
    // Two replays of the same command must produce byte-identical
    // event payloads.
    expect(JSON.stringify(screen(busy))).toBe(JSON.stringify(screen(busy)));
  });

  it("produces a plain JSON-serializable payload safe to persist on an event", () => {
    const result = screen(busy);
    expect(JSON.parse(JSON.stringify(result)) as unknown).toEqual(result);
  });

  it("carries no identifier the caller did not supply as a record id or a code", () => {
    // The PHI invariant, mechanically: everything in a finding traces
    // back to a code or an opaque record id that the caller chose.
    const permitted = new Set([
      "line-candidate",
      "line-other",
      "allergy-1",
      "DRUG_DOSED",
      "DRUG_UNKNOWN",
      "ING_DELTA",
    ]);
    const seen: string[] = [];
    for (const finding of allFindings(screen(busy))) {
      for (const trigger of finding.triggers) {
        seen.push(trigger.recordId, trigger.code);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((value) => !permitted.has(value))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint identity — what keeps carry-forward from becoming a hole
// ---------------------------------------------------------------------------

describe("screenPrescription — an acknowledgement suppresses only what was shown", () => {
  function dosedLine(recordId: string, amount: number, dosesPerDay: number): PrescribedDrug {
    return drug(recordId, "DRUG_DOSED", { amount, unit: "mg", dosesPerDay });
  }

  it("does not let an acknowledged overdose suppress a larger one", () => {
    // The regression this guards: acknowledge 12mg against a 10mg
    // maximum in January, meet 200mg in February, and be shown
    // nothing — with the absence of an alert now actively reassuring.
    const january = screen({ candidate: dosedLine("line-january", 12, 1) });
    const acknowledged = new Set([
      requireFinding(january, "SCR_DOSE_ABOVE_SINGLE_MAXIMUM").fingerprint,
    ]);

    const february = screen({
      candidate: dosedLine("line-february", 200, 1),
      acknowledgedFingerprints: acknowledged,
    });
    expect(requireFinding(february, "SCR_DOSE_ABOVE_SINGLE_MAXIMUM").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });

  it("does not let an acknowledged daily total suppress a larger one", () => {
    const january = screen({ candidate: dosedLine("line-january", 12, 3) });
    const acknowledged = new Set([
      requireFinding(january, "SCR_DOSE_ABOVE_DAILY_MAXIMUM").fingerprint,
    ]);

    const february = screen({
      candidate: dosedLine("line-february", 100, 3),
      acknowledgedFingerprints: acknowledged,
    });
    expect(requireFinding(february, "SCR_DOSE_ABOVE_DAILY_MAXIMUM").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });

  it("still stops re-prompting a patient stable on the same above-range dose", () => {
    // The case worth protecting: palliative and oncology regimens sit
    // above the population range indefinitely and correctly. Asking
    // every month is how the acknowledgement becomes reflexive.
    const january = screen({ candidate: dosedLine("line-january", 50, 4) });
    const acknowledged = new Set(
      allFindings(january)
        .filter((f) => f.disposition === "REQUIRES_ACKNOWLEDGEMENT")
        .map((f) => f.fingerprint)
    );
    expect(acknowledged.size).toBeGreaterThan(0);

    const february = screen({
      candidate: dosedLine("line-february", 50, 4),
      acknowledgedFingerprints: acknowledged,
    });
    expect(findingsRequiringAcknowledgement(february)).toEqual([]);
  });

  it("re-prompts when only the unit pairing changes", () => {
    const inMicrograms = screen({
      candidate: drug("line-1", "DRUG_DOSED", { amount: 5000, unit: "mcg", dosesPerDay: 1 }),
    });
    const acknowledged = new Set([
      requireFinding(inMicrograms, "SCR_DOSE_UNIT_NOT_COMPARABLE").fingerprint,
    ]);

    const inGrams = screen({
      candidate: drug("line-2", "DRUG_DOSED", { amount: 5, unit: "g", dosesPerDay: 1 }),
      acknowledgedFingerprints: acknowledged,
    });
    expect(requireFinding(inGrams, "SCR_DOSE_UNIT_NOT_COMPARABLE").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });

  it("does not let an acknowledged unscreened profile entry suppress an unscreened prescription", () => {
    // Same drug code, same finding code, but one of them means "we
    // screened nothing at all for this prescription".
    const asProfileEntry = screen({
      activeMedications: [drug("line-other", "DRUG_UNKNOWN")],
    });
    const acknowledged = new Set([
      requireFinding(asProfileEntry, "SCR_KNOWLEDGE_UNAVAILABLE").fingerprint,
    ]);

    const asCandidate = screen({
      candidate: drug("line-candidate", "DRUG_UNKNOWN"),
      acknowledgedFingerprints: acknowledged,
    });
    expect(requireFinding(asCandidate, "SCR_KNOWLEDGE_UNAVAILABLE").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });

  it("does not let an acknowledged intolerance suppress the same substance recorded as an allergy", () => {
    const asIntolerance = screen({
      allergies: [allergy({ type: "INTOLERANCE", criticality: "HIGH" })],
    });
    const acknowledged = new Set([
      requireFinding(asIntolerance, "SCR_DRUG_ALLERGY_DIRECT").fingerprint,
    ]);

    const asAllergy = screen({
      allergies: [allergy({ type: "ALLERGY", criticality: "LOW" })],
      acknowledgedFingerprints: acknowledged,
    });
    expect(requireFinding(asAllergy, "SCR_DRUG_ALLERGY_DIRECT").disposition).toBe(
      "REQUIRES_ACKNOWLEDGEMENT"
    );
  });
});

/**
 * Replace every trigger code in the reason with a placeholder.
 *
 * The fingerprint holds trigger codes as an unordered SET, on purpose,
 * so an A-against-B finding and a B-against-A finding share an identity
 * while their reasons name the two codes in opposite order. Masking
 * removes exactly that legitimate difference and leaves the sentence
 * template plus every magnitude, unit and varying word — which is
 * precisely what the fingerprint's qualifiers are supposed to cover.
 *
 * Longest code first, so one code that is a prefix of another cannot
 * mask it half way.
 */
function maskTriggerCodes(finding: ScreeningFinding): string {
  const codes = [...new Set(finding.triggers.map((t) => t.code))].sort(
    (a, b) => b.length - a.length
  );
  let masked = finding.reason;
  for (const code of codes) {
    masked = masked.split(code).join("<code>");
  }
  return masked;
}

/**
 * Every finding produced across a wide sweep of inputs.
 *
 * Deliberately combinatorial rather than curated: the point is to
 * catch a collision nobody thought to write a case for.
 */
function findingCorpus(): ReadonlyArray<ScreeningFinding> {
  const doses: ReadonlyArray<PrescribedDrug["dose"]> = [
    null,
    { amount: 12, unit: "mg", dosesPerDay: 1 },
    { amount: 200, unit: "mg", dosesPerDay: 1 },
    { amount: 12, unit: "mg", dosesPerDay: 3 },
    { amount: 100, unit: "mg", dosesPerDay: 3 },
    { amount: 50, unit: "mg", dosesPerDay: 4 },
    { amount: 2, unit: "mg", dosesPerDay: 1 },
    { amount: 1, unit: "mg", dosesPerDay: 2 },
    { amount: 5000, unit: "mcg", dosesPerDay: 1 },
    { amount: 5, unit: "g", dosesPerDay: 2 },
  ];
  const candidateCodes = ["DRUG_ALFA", "DRUG_DOSED", "DRUG_COMBO", "DRUG_UNKNOWN"];
  const profiles: ReadonlyArray<ReadonlyArray<string>> = [
    [],
    ["DRUG_BRAVO"],
    ["DRUG_ALFA_GENERIC"],
    ["DRUG_CHARLIE"],
    ["DRUG_ECHO"],
    ["DRUG_UNKNOWN"],
    ["DRUG_BRAVO", "DRUG_UNKNOWN"],
    ["DRUG_COMBO", "DRUG_CHARLIE"],
  ];
  const allergyLists: ReadonlyArray<ReadonlyArray<RecordedAllergy>> = [
    [],
    [allergy()],
    [allergy({ type: "INTOLERANCE" })],
    [allergy({ criticality: "LOW" })],
    [allergy({ criticality: "UNABLE_TO_ASSESS" })],
    [allergy({ verificationStatus: "UNCONFIRMED" })],
    [allergy({ substanceCode: "ALLERGEN_XRAY" })],
    [allergy({ substanceCode: "ALLERGEN_XRAY", type: "INTOLERANCE" })],
    [allergy({ substanceCode: "ING_DELTA", criticality: "LOW" })],
  ];

  const found: ScreeningFinding[] = [];
  for (const candidateCode of candidateCodes) {
    for (const dose of doses) {
      for (const profile of profiles) {
        for (const allergies of allergyLists) {
          found.push(
            ...allFindings(
              screen({
                candidate: drug("line-candidate", candidateCode, dose),
                activeMedications: profile.map((code, index) => drug(`line-${index}`, code)),
                allergies,
              })
            )
          );
        }
      }
    }
  }
  return found;
}

describe("screenPrescription — fingerprint identity holds across every finding kind", () => {
  // These two are the general guard the specific cases above are
  // examples of. A future finding kind that interpolates a magnitude
  // into its reason without declaring it as a qualifier fails here,
  // whether or not anyone remembers to write a case for it.
  it("gives two findings the same fingerprint only when they say the same thing", () => {
    const seenByFingerprint = new Map<string, ScreeningFinding>();
    // A set, not a list: the same clash recurs across hundreds of
    // screens in the corpus, and a thousand copies of one line would
    // hide how many DISTINCT problems there are.
    const collisions = new Set<string>();

    for (const finding of findingCorpus()) {
      const seen = seenByFingerprint.get(finding.fingerprint);
      if (seen === undefined) {
        seenByFingerprint.set(finding.fingerprint, finding);
        continue;
      }
      if (maskTriggerCodes(seen) !== maskTriggerCodes(finding)) {
        collisions.add(
          `${finding.fingerprint}\n    "${maskTriggerCodes(seen)}"\n    "${maskTriggerCodes(finding)}"`
        );
      }
    }

    // Collisions first: when this trips, the list of clashing
    // sentences is the whole diagnosis, and a corpus-size failure
    // ahead of it would bury the useful output.
    expect([...collisions]).toEqual([]);
    // Guard the guard: a corpus that produced almost nothing would
    // pass the above vacuously.
    expect(seenByFingerprint.size).toBeGreaterThan(20);
  });

  it("gives two findings the same fingerprint only when they are graded the same", () => {
    // "Never a more severe instance" stated directly. Severity and
    // certainty are in the fingerprint, so this holds by construction
    // — pinned because it is the invariant, not an implementation
    // detail of it.
    const gradingByFingerprint = new Map<string, string>();
    const collisions = new Set<string>();

    for (const finding of findingCorpus()) {
      const grading = `${finding.severity}/${finding.certainty}`;
      const seen = gradingByFingerprint.get(finding.fingerprint);
      if (seen === undefined) {
        gradingByFingerprint.set(finding.fingerprint, grading);
        continue;
      }
      if (seen !== grading) {
        collisions.add(`${finding.fingerprint}: ${seen} vs ${grading}`);
      }
    }

    expect([...collisions]).toEqual([]);
  });
});

describe("selectors", () => {
  it("partition findings by what the workflow must do about them", () => {
    const result = screen({
      allergies: [allergy()],
      activeMedications: [drug("line-other", "DRUG_ALFA_GENERIC")],
    });
    expect(hardStopFindings(result).map((f) => f.code)).toEqual(["SCR_DRUG_ALLERGY_DIRECT"]);
    expect(findingsRequiringAcknowledgement(result).map((f) => f.code)).toEqual([
      "SCR_DUPLICATE_INGREDIENT",
    ]);
  });

  it("return empty arrays for a clear evaluation", () => {
    const result = screen();
    expect(hardStopFindings(result)).toEqual([]);
    expect(findingsRequiringAcknowledgement(result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No axis contributes nothing in silence
//
// The general guard, in the same spirit as the fingerprint invariant
// above: a case written for allergies would pass forever while the
// next axis someone adds repeats the bug. These iterate
// `CLINICAL_SCREENING_AXES`, which is derived from the finding kinds,
// so a fifth clinical question is covered the day it is declared.
//
// The bug being guarded, concretely: `allergies: []` made the allergy
// loop iterate zero times and contribute no findings, and `dose:
// null` made the dose collector return early with no finding. On both
// axes the engine reported nothing, and nothing is indistinguishable
// from clean — while the allergy axis is the only one that can reach
// a hard stop at all.
// ---------------------------------------------------------------------------

describe("screenPrescription — every clinical axis either runs or reports a gap", () => {
  /**
   * Request shapes the sweep runs each axis against. Deliberately
   * includes the unknown-candidate case, where the engine already
   * reports one gap of its own: an unsupplied input is a different
   * fact with a different owner, and must not be swallowed by it.
   */
  const shapes: ReadonlyArray<readonly [string, Partial<ScreeningRequest>]> = [
    ["bare candidate", {}],
    [
      "rich inputs",
      {
        candidate: drug("line-candidate", "DRUG_DOSED", { amount: 50, unit: "mg", dosesPerDay: 4 }),
        activeMedications: [drug("line-other", "DRUG_BRAVO")],
        allergies: [allergy({ substanceCode: "ING_DELTA", criticality: "LOW" })],
      },
    ],
    [
      "candidate the knowledge source does not recognise",
      { candidate: drug("line-candidate", "DRUG_UNKNOWN") },
    ],
  ];

  it("the axis list is exactly the clinical finding kinds", () => {
    // The join between the two vocabularies. If a finding kind is
    // added without becoming an axis, every guarantee below silently
    // stops covering it — so the derivation is pinned rather than
    // trusted.
    expect(new Set(CLINICAL_SCREENING_AXES)).toEqual(
      new Set(SCREENING_FINDING_KINDS.filter((kind) => kind !== "SCREENING_GAP"))
    );
  });

  it("reports a gap naming any axis whose input the caller could not supply", () => {
    for (const axis of CLINICAL_SCREENING_AXES) {
      for (const [label, shape] of shapes) {
        const result = screen({ ...shape, inputAvailability: withoutAxis(axis) });
        const gaps = allFindings(result).filter(
          (f) => f.code === INPUT_UNAVAILABLE_CODE_FOR_AXIS[axis]
        );
        expect(gaps, `${axis} / ${label}`).toHaveLength(1);
        expect(gaps[0]?.kind).toBe("SCREENING_GAP");
      }
    }
  });

  it("contributes no finding of its own kind for an axis it could not screen", () => {
    // The other half: a gap that fired while the axis ALSO produced
    // findings would mean the declaration was ignored, and a caller
    // would be told both that we could not check and what we found.
    for (const axis of CLINICAL_SCREENING_AXES) {
      for (const [label, shape] of shapes) {
        const result = screen({ ...shape, inputAvailability: withoutAxis(axis) });
        expect(
          allFindings(result).filter((f) => f.kind === axis),
          `${axis} / ${label}`
        ).toEqual([]);
      }
    }
  });

  it("grades every unsupplied-input gap so it interrupts but never blocks", () => {
    // Same grading as `SCR_KNOWLEDGE_UNAVAILABLE`, capped for the same
    // reason: refusing to dispense because OUR platform cannot hold
    // an allergy list would make our missing capability the patient's
    // problem.
    for (const axis of CLINICAL_SCREENING_AXES) {
      const gap = requireFinding(
        screen({ inputAvailability: withoutAxis(axis) }),
        INPUT_UNAVAILABLE_CODE_FOR_AXIS[axis]
      );
      expect(gap.severity, axis).toBe("MODERATE");
      expect(gap.certainty, axis).toBe("DEFINITE");
      expect(gap.disposition, axis).toBe("REQUIRES_ACKNOWLEDGEMENT");
    }
  });

  it("declaring nothing available yields exactly one gap per axis and no clinical finding", () => {
    const allUnavailable = Object.fromEntries(
      CLINICAL_SCREENING_AXES.map((axis) => [axis, "UNAVAILABLE"])
    ) as Record<ScreeningInputAxis, ScreeningInputAvailability>;

    const result = screen({
      candidate: drug("line-candidate", "DRUG_DOSED", { amount: 50, unit: "mg", dosesPerDay: 4 }),
      activeMedications: [drug("line-other", "DRUG_ECHO")],
      allergies: [allergy()],
      inputAvailability: allUnavailable,
    });

    expect(new Set(codes(result))).toEqual(
      new Set(CLINICAL_SCREENING_AXES.map((axis) => INPUT_UNAVAILABLE_CODE_FOR_AXIS[axis]))
    );
    // Nothing was screened, so nothing can block — including the
    // contraindicated pair and the confirmed high-criticality allergy
    // sitting unread in the inputs.
    expect(hardStopFindings(result)).toEqual([]);
    expect(result.outcome).toBe("ADVISORY");
  });

  it("does not gap an axis whose inputs are genuinely empty", () => {
    // The distinction the whole design turns on: "this patient has no
    // recorded allergies" is not "this platform cannot tell you about
    // allergies". If emptiness implied a gap, every clean patient
    // would meet a permanent alert, and an alert that always fires is
    // one that gets trained away.
    const result = screen({ allergies: [], activeMedications: [] });
    expect(result.outcome).toBe("CLEAR");
    expect(codes(result)).toEqual([]);
  });

  it("fingerprints an unsupplied axis identically across drugs and lines", () => {
    // One acknowledgement per pharmacist settles "we cannot screen
    // allergies" for the whole order. Were the drug code part of the
    // identity, a three-line order would ask three times for the same
    // platform-level fact — the fastest possible route to a reflexive
    // click-through.
    const first = requireFinding(
      screen({
        candidate: drug("line-1", "DRUG_ALFA"),
        inputAvailability: withoutAxis("DRUG_ALLERGY"),
      }),
      "SCR_ALLERGY_INPUT_UNAVAILABLE"
    );
    const second = requireFinding(
      screen({
        candidate: drug("line-2", "DRUG_BRAVO"),
        inputAvailability: withoutAxis("DRUG_ALLERGY"),
      }),
      "SCR_ALLERGY_INPUT_UNAVAILABLE"
    );
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("gives two unsupplied axes different fingerprints", () => {
    // An acknowledgement of "we cannot screen doses" must not settle
    // "we cannot screen allergies".
    const seen = new Set(
      CLINICAL_SCREENING_AXES.map(
        (axis) =>
          requireFinding(
            screen({ inputAvailability: withoutAxis(axis) }),
            INPUT_UNAVAILABLE_CODE_FOR_AXIS[axis]
          ).fingerprint
      )
    );
    expect(seen.size).toBe(CLINICAL_SCREENING_AXES.length);
  });
});
