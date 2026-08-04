import { describe, expect, it } from "vitest";

import {
  dispositionFor,
  fingerprintOf,
  gapRemediationForFindingCode,
  gapRemediationFromSeverity,
  isAtLeastAsSevere,
  leastSevere,
  screeningGapSeverity,
  severityRank,
  suggestedPv1RejectionReason,
  toFhirDetectedIssueSeverity,
  SCREENING_CERTAINTIES,
  SCREENING_FINDING_KINDS,
  SCREENING_GAP_REMEDIATIONS,
  SCREENING_SEVERITIES,
  SUGGESTED_PV1_REJECTION_REASONS,
  type FingerprintInput,
  type ScreeningTrigger,
} from "./index.js";

// ---------------------------------------------------------------------------
// Gap grading
// ---------------------------------------------------------------------------

describe("screening gap grading", () => {
  it("recovers every remediation from what a persisted row carries", () => {
    // A reader of `order_screening_finding` recovers what a gap row
    // means from the row's CODE first (`gapRemediationForFindingCode`)
    // and its SEVERITY second (`gapRemediationFromSeverity`). Since
    // ORGANIZATION_DATA and PLATFORM_CAPABILITY share MINOR, severity
    // alone is no longer injective — the codes that carry
    // ORGANIZATION_DATA were minted with fixed remediation precisely
    // so the two-step recovery stays exact. If this loop ever fails,
    // the console has started telling pharmacists to chase gaps
    // nobody can close (or to ignore gaps their org can).
    const codeCarrying: Record<string, string> = {
      ORGANIZATION_DATA: "SCR_COMPOUND_FORMULA_NOT_CODED",
    };
    for (const remediation of SCREENING_GAP_REMEDIATIONS) {
      const code = codeCarrying[remediation] ?? "SCR_KNOWLEDGE_UNAVAILABLE";
      const recovered =
        gapRemediationForFindingCode(code) ??
        gapRemediationFromSeverity(screeningGapSeverity(remediation));
      expect(recovered, remediation).toBe(remediation);
    }
  });

  it("keeps historical MINOR rows reading as PLATFORM_CAPABILITY", () => {
    // Every MINOR gap row written before ORGANIZATION_DATA existed
    // actually carried PLATFORM_CAPABILITY, and severity-based
    // recovery must keep saying so — the new value is recovered from
    // its codes, never from the shared severity.
    expect(gapRemediationFromSeverity("MINOR")).toBe("PLATFORM_CAPABILITY");
    expect(gapRemediationFromSeverity("MODERATE")).toBe("SUBJECT_DATA");
  });

  it("fixes the remediation of the compound-coverage codes by construction", () => {
    expect(gapRemediationForFindingCode("SCR_COMPOUND_FORMULA_NOT_CODED")).toBe(
      "ORGANIZATION_DATA"
    );
    expect(gapRemediationForFindingCode("SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED")).toBe(
      "ORGANIZATION_DATA"
    );
    // Codes that can be raised under more than one remediation answer
    // null and defer to severity — see gapRemediationFromSeverity.
    expect(gapRemediationForFindingCode("SCR_KNOWLEDGE_UNAVAILABLE")).toBeNull();
    expect(gapRemediationForFindingCode("SCR_ALLERGY_INPUT_UNAVAILABLE")).toBeNull();
  });

  it("grades no gap at a severity that could block", () => {
    // A gap must never reach HARD_STOP: refusing to dispense because
    // OUR platform cannot screen would make our deficiency the
    // patient's problem.
    for (const remediation of SCREENING_GAP_REMEDIATIONS) {
      const severity = screeningGapSeverity(remediation);
      expect(dispositionFor(severity, "DEFINITE"), remediation).not.toBe("HARD_STOP");
    }
  });

  it("returns null for a severity no gap carries", () => {
    const gapSeverities = new Set(SCREENING_GAP_REMEDIATIONS.map(screeningGapSeverity));
    for (const severity of SCREENING_SEVERITIES) {
      if (gapSeverities.has(severity)) continue;
      expect(gapRemediationFromSeverity(severity), severity).toBeNull();
    }
  });
});

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

  function print(overrides: Partial<FingerprintInput> = {}): string {
    return fingerprintOf({
      code: "SCR_DRUG_INTERACTION",
      severity: "MODERATE",
      certainty: "PROBABLE",
      triggers: [
        t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
        t("PROFILE_MEDICATION", "line-2", "ING_BRAVO"),
      ],
      qualifiers: [],
      ...overrides,
    });
  }

  it("ignores trigger order", () => {
    expect(
      print({
        triggers: [
          t("PROFILE_MEDICATION", "line-2", "ING_BRAVO"),
          t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
        ],
      })
    ).toBe(print());
  });

  it("ignores which side of the screen a code came from", () => {
    // The A-against-B and B-against-A screens are the same clinical
    // situation. If the fingerprint distinguished them, dispensing the
    // pair in the other order would resurrect a settled alert.
    expect(
      print({
        triggers: [
          t("CANDIDATE_DRUG", "line-2", "ING_BRAVO"),
          t("PROFILE_MEDICATION", "line-1", "ING_ALFA"),
        ],
      })
    ).toBe(print());
  });

  it("ignores record ids so an acknowledgement survives a refill", () => {
    expect(
      print({
        triggers: [
          t("CANDIDATE_DRUG", "line-february", "ING_ALFA"),
          t("PROFILE_MEDICATION", "line-2", "ING_BRAVO"),
        ],
      })
    ).toBe(print());
  });

  it("distinguishes different finding codes over identical triggers", () => {
    expect(print({ code: "SCR_DUPLICATE_INGREDIENT" })).not.toBe(print());
  });

  it("distinguishes a more severe instance of the same situation", () => {
    // The structural half of the "an acknowledgement may never
    // suppress something worse" invariant: an upgraded grading cannot
    // reuse the acknowledged identity, whatever the finding kind.
    expect(print({ severity: "MAJOR" })).not.toBe(print());
    expect(print({ severity: "CONTRAINDICATED" })).not.toBe(print());
  });

  it("distinguishes a more certain instance of the same situation", () => {
    expect(print({ certainty: "DEFINITE" })).not.toBe(print());
  });

  it("distinguishes instances that differ only in a qualifier", () => {
    // The other half: same code, same codes, same grading, different
    // magnitude. This is the dose case.
    expect(print({ qualifiers: ["dailyTotal=12mg"] })).not.toBe(
      print({ qualifiers: ["dailyTotal=200mg"] })
    );
  });

  it("ignores the order qualifiers were built in", () => {
    expect(print({ qualifiers: ["limit=10mg", "dose=12mg"] })).toBe(
      print({ qualifiers: ["dose=12mg", "limit=10mg"] })
    );
  });

  it("collapses a repeated code to one occurrence", () => {
    expect(
      fingerprintOf({
        code: "SCR_DRUG_ALLERGY_DIRECT",
        severity: "CONTRAINDICATED",
        certainty: "DEFINITE",
        triggers: [
          t("RECORDED_ALLERGY", "allergy-1", "ING_ALFA"),
          t("CANDIDATE_DRUG", "line-1", "ING_ALFA"),
        ],
        qualifiers: [],
      })
    ).toBe("SCR_DRUG_ALLERGY_DIRECT|CONTRAINDICATED/DEFINITE|ING_ALFA");
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

  it("only ever returns a member of the published list", () => {
    // The list is what `@pharmax/verification` checks against its own
    // registry, so it has to be the complete set of what can come out
    // of here. See rejection-reasons.test.ts in that package.
    const produced = SCREENING_FINDING_KINDS.map(suggestedPv1RejectionReason).filter(
      (reason) => reason !== null
    );
    expect(produced.length).toBeGreaterThan(0);
    for (const reason of produced) {
      expect(SUGGESTED_PV1_REJECTION_REASONS).toContain(reason);
    }
  });

  it("suggests nothing for a screening gap", () => {
    // A gap means "go and look this up", never "bounce it back to the
    // typist" — the typist cannot fix our missing reference data.
    expect(suggestedPv1RejectionReason("SCREENING_GAP")).toBeNull();
  });
});
