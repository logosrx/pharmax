import { describe, expect, it } from "vitest";

import {
  dispositionFor,
  fingerprintOf,
  isAtLeastAsSevere,
  leastSevere,
  severityRank,
  suggestedPv1RejectionReason,
  toFhirDetectedIssueSeverity,
  SCREENING_CERTAINTIES,
  SCREENING_FINDING_KINDS,
  SCREENING_SEVERITIES,
  type ScreeningTrigger,
} from "./index.js";

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

describe("severity ordering", () => {
  it("declares severities in strictly descending order of rank", () => {
    // The declaration order is load-bearing: UI code and docs read the
    // list top-down as "worst first". A reordering that broke the
    // ranking would be invisible without this.
    const ranks = SCREENING_SEVERITIES.map(severityRank);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i - 1]).toBeGreaterThan(ranks[i] as number);
    }
  });

  it("treats a severity as at least as severe as itself", () => {
    for (const severity of SCREENING_SEVERITIES) {
      expect(isAtLeastAsSevere(severity, severity)).toBe(true);
    }
  });

  it("orders across the whole scale", () => {
    expect(isAtLeastAsSevere("CONTRAINDICATED", "MINOR")).toBe(true);
    expect(isAtLeastAsSevere("MINOR", "CONTRAINDICATED")).toBe(false);
    expect(isAtLeastAsSevere("MAJOR", "MODERATE")).toBe(true);
    expect(isAtLeastAsSevere("MODERATE", "MAJOR")).toBe(false);
  });

  it("leastSevere returns the weaker grade and is order-independent", () => {
    expect(leastSevere("CONTRAINDICATED", "MODERATE")).toBe("MODERATE");
    expect(leastSevere("MODERATE", "CONTRAINDICATED")).toBe("MODERATE");
    expect(leastSevere("MAJOR", "MAJOR")).toBe("MAJOR");
  });
});

// ---------------------------------------------------------------------------
// FHIR projection
// ---------------------------------------------------------------------------

describe("toFhirDetectedIssueSeverity", () => {
  it.each(SCREENING_SEVERITIES)("maps %s onto a FHIR severity", (severity) => {
    expect(["high", "moderate", "low"]).toContain(toFhirDetectedIssueSeverity(severity));
  });

  it("collapses CONTRAINDICATED and MAJOR onto high rather than downward", () => {
    // FHIR has no fourth value. Mapping CONTRAINDICATED to anything
    // below `high` would understate it to every external consumer.
    expect(toFhirDetectedIssueSeverity("CONTRAINDICATED")).toBe("high");
    expect(toFhirDetectedIssueSeverity("MAJOR")).toBe("high");
    expect(toFhirDetectedIssueSeverity("MODERATE")).toBe("moderate");
    expect(toFhirDetectedIssueSeverity("MINOR")).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// The hard-stop rule
// ---------------------------------------------------------------------------

describe("dispositionFor", () => {
  it("hard-stops on exactly one cell of the severity x certainty matrix", () => {
    // This is the assertion the whole product rests on. If a change
    // makes a second combination blocking, it must be a deliberate
    // decision that updates this test, not a side effect.
    const blocking: string[] = [];
    for (const severity of SCREENING_SEVERITIES) {
      for (const certainty of SCREENING_CERTAINTIES) {
        if (dispositionFor(severity, certainty) === "HARD_STOP") {
          blocking.push(`${severity}/${certainty}`);
        }
      }
    }
    expect(blocking).toEqual(["CONTRAINDICATED/DEFINITE"]);
  });

  it("downgrades an uncertain contraindication to acknowledgement", () => {
    expect(dispositionFor("CONTRAINDICATED", "PROBABLE")).toBe("REQUIRES_ACKNOWLEDGEMENT");
    expect(dispositionFor("CONTRAINDICATED", "POSSIBLE")).toBe("REQUIRES_ACKNOWLEDGEMENT");
  });

  it("never blocks on MAJOR, however certain", () => {
    for (const certainty of SCREENING_CERTAINTIES) {
      expect(dispositionFor("MAJOR", certainty)).toBe("REQUIRES_ACKNOWLEDGEMENT");
    }
  });

  it("routes MINOR to informational regardless of certainty", () => {
    for (const certainty of SCREENING_CERTAINTIES) {
      expect(dispositionFor("MINOR", certainty)).toBe("INFORMATIONAL");
    }
  });
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

describe("fingerprintOf", () => {
  function t(source: ScreeningTrigger["source"], recordId: string, code: string): ScreeningTrigger {
    return { source, recordId, code };
  }

  it("ignores trigger order", () => {
    const a = fingerprintOf("SCR_DRUG_INTERACTION", [
      t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
      t("PROFILE_MEDICATION", "line-2", "ING_BRAVO"),
    ]);
    const b = fingerprintOf("SCR_DRUG_INTERACTION", [
      t("PROFILE_MEDICATION", "line-2", "ING_BRAVO"),
      t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
    ]);
    expect(a).toBe(b);
  });

  it("ignores which side of the screen a code came from", () => {
    // The A-against-B and B-against-A screens are the same clinical
    // situation. If the fingerprint distinguished them, dispensing the
    // pair in the other order would resurrect a settled alert.
    const dispensingAlfa = fingerprintOf("SCR_DRUG_INTERACTION", [
      t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
      t("PROFILE_MEDICATION", "line-2", "ING_BRAVO"),
    ]);
    const dispensingBravo = fingerprintOf("SCR_DRUG_INTERACTION", [
      t("CANDIDATE_DRUG", "line-2", "ING_BRAVO"),
      t("PROFILE_MEDICATION", "line-1", "ING_ALFA"),
    ]);
    expect(dispensingAlfa).toBe(dispensingBravo);
  });

  it("ignores record ids so an acknowledgement survives a refill", () => {
    const original = fingerprintOf("SCR_DUPLICATE_INGREDIENT", [
      t("CANDIDATE_DRUG", "line-jan", "ING_ALFA"),
      t("PROFILE_MEDICATION", "line-old", "ING_ALFA"),
    ]);
    const refill = fingerprintOf("SCR_DUPLICATE_INGREDIENT", [
      t("CANDIDATE_DRUG", "line-feb", "ING_ALFA"),
      t("PROFILE_MEDICATION", "line-old", "ING_ALFA"),
    ]);
    expect(refill).toBe(original);
  });

  it("distinguishes different finding codes over identical triggers", () => {
    const triggers = [t("CANDIDATE_DRUG", "line-1", "ING_ALFA")];
    expect(fingerprintOf("SCR_DUPLICATE_INGREDIENT", triggers)).not.toBe(
      fingerprintOf("SCR_DRUG_INTERACTION", triggers)
    );
  });

  it("collapses a repeated code to one occurrence", () => {
    expect(
      fingerprintOf("SCR_DRUG_ALLERGY_DIRECT", [
        t("RECORDED_ALLERGY", "allergy-1", "ING_ALFA"),
        t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
      ])
    ).toBe("SCR_DRUG_ALLERGY_DIRECT|ING_ALFA");
  });
});

// ---------------------------------------------------------------------------
// PV1 rejection-reason hints
// ---------------------------------------------------------------------------

describe("suggestedPv1RejectionReason", () => {
  it.each(SCREENING_FINDING_KINDS)("returns a total answer for %s", (kind) => {
    // Exhaustiveness is compiler-enforced; this pins that no kind
    // resolves to undefined at runtime.
    expect(suggestedPv1RejectionReason(kind)).not.toBeUndefined();
  });

  it("maps each clinical kind onto the matching PV1 reason code", () => {
    expect(suggestedPv1RejectionReason("DRUG_DRUG_INTERACTION")).toBe("DRUG_INTERACTION");
    expect(suggestedPv1RejectionReason("DRUG_ALLERGY")).toBe("ALLERGY_CONFLICT");
    expect(suggestedPv1RejectionReason("THERAPEUTIC_DUPLICATION")).toBe("DUPLICATE_THERAPY");
    expect(suggestedPv1RejectionReason("DOSE_RANGE")).toBe("DOSE_INCORRECT");
  });

  it("suggests nothing for a screening gap", () => {
    // A gap means "go and look this up", never "bounce it back to the
    // typist" — the typist cannot fix our missing reference data.
    expect(suggestedPv1RejectionReason("SCREENING_GAP")).toBeNull();
  });
});
