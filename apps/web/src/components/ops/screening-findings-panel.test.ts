// What the findings panel does and does not put on the screen.
//
// These assertions are about ABSENCE, which is why they render the
// component rather than testing the projection that feeds it. "A hard
// stop has no acknowledge control" cannot be checked by inspecting a
// boolean: the question is whether a form, a button, or anything that
// invites a click reaches the markup. Nor is a disabled control
// acceptable — a greyed button still reads as "there is a way through
// here if I insist", and for a hard stop there is not.
//
// The other property pinned here is that there is no BULK control:
// the number of submitting forms equals the number of findings that
// individually need this pharmacist's judgement, so no single click
// can ever settle two.
//
// CLEAN ROOM / PHI: every code and sentence below is synthetic.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  OrderScreening,
  OrderScreeningFindingView,
  ScreeningFindingGroup,
} from "../../server/ops/get-order-screening.js";

import { ScreeningFindingsPanel, type AcknowledgeGate } from "./screening-findings-panel.js";

const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ACK_ACTION = `/api/ops/orders/${ORDER_ID}/acknowledge-pv1-screening-finding`;

interface FindingOverrides {
  readonly findingId?: string;
  readonly code?: string;
  readonly kind?: string;
  readonly severity?: string;
  readonly certainty?: string;
  readonly disposition?: string;
  readonly fingerprint?: string;
  readonly group?: ScreeningFindingGroup;
  readonly acknowledgedByViewer?: boolean;
  readonly acknowledgeable?: boolean;
  readonly citation?: string | null;
  readonly patientScopeCoverage?: OrderScreeningFindingView["patientScopeCoverage"];
}

function finding(overrides: FindingOverrides = {}): OrderScreeningFindingView {
  const disposition = overrides.disposition ?? "REQUIRES_ACKNOWLEDGEMENT";
  const acknowledgedByViewer = overrides.acknowledgedByViewer ?? false;
  return {
    patientScopeCoverage: overrides.patientScopeCoverage ?? null,
    findingId: overrides.findingId ?? "f-1",
    code: overrides.code ?? "SCR_DRUG_INTERACTION",
    kind: overrides.kind ?? "DRUG_DRUG_INTERACTION",
    severity: overrides.severity ?? "MAJOR",
    certainty: overrides.certainty ?? "PROBABLE",
    disposition,
    fingerprint: overrides.fingerprint ?? "FP-INTERACTION",
    reason: "Synthetic interaction between INGREDIENT_ALFA and INGREDIENT_BRAVO.",
    citation: overrides.citation ?? null,
    triggers: [{ source: "CANDIDATE_DRUG", code: "INGREDIENT_ALFA" }],
    group: overrides.group ?? "CLINICAL",
    acknowledgedByViewer,
    acknowledgeable:
      overrides.acknowledgeable ??
      (disposition === "REQUIRES_ACKNOWLEDGEMENT" && !acknowledgedByViewer),
  };
}

function screeningOf(findings: ReadonlyArray<OrderScreeningFindingView>): OrderScreening {
  return {
    screenedAt: new Date("2026-08-03T12:00:00.000Z"),
    phase: "PV1_START" as OrderScreening["phase"],
    findings,
    hardStopCount: findings.filter((f) => f.disposition === "HARD_STOP").length,
    outstandingCount: findings.filter((f) => f.acknowledgeable).length,
  };
}

function render(
  findings: ReadonlyArray<OrderScreeningFindingView>,
  gate: AcknowledgeGate = { kind: "OPEN" }
): string {
  return renderToStaticMarkup(
    createElement(ScreeningFindingsPanel, {
      orderId: ORDER_ID,
      screening: screeningOf(findings),
      gate,
    })
  );
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("ScreeningFindingsPanel", () => {
  it("renders no acknowledge control of any kind for a HARD_STOP", () => {
    const html = render([
      finding({
        code: "SCR_DRUG_ALLERGY_DIRECT",
        kind: "DRUG_ALLERGY",
        severity: "CONTRAINDICATED",
        certainty: "DEFINITE",
        disposition: "HARD_STOP",
        fingerprint: "FP-HARD-STOP",
      }),
    ]);

    // Not "a disabled button" — nothing clickable at all.
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(ACK_ACTION);
    expect(html).not.toContain("FP-HARD-STOP");
    // And it says why, so the absence reads as a decision.
    expect(html).toContain("No override path");
    expect(html).toContain("reject");
  });

  it("offers exactly one acknowledge form per outstanding finding, and no bulk control", () => {
    const html = render([
      finding({ findingId: "f-a", fingerprint: "FP-A" }),
      finding({ findingId: "f-b", fingerprint: "FP-B", code: "SCR_DUPLICATE_INGREDIENT" }),
      finding({
        findingId: "f-c",
        fingerprint: "FP-C",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        group: "PLATFORM_CAPABILITY",
      }),
    ]);

    expect(countOf(html, "<form")).toBe(3);
    expect(countOf(html, 'type="submit"')).toBe(3);
    for (const fingerprint of ["FP-A", "FP-B", "FP-C"]) {
      expect(html).toContain(`value="${fingerprint}"`);
    }
  });

  it("posts the finding's own fingerprint to the acknowledge route", () => {
    const html = render([finding({ fingerprint: "FP-INTERACTION" })]);
    expect(html).toContain(`action="${ACK_ACTION}"`);
    expect(html).toContain('name="fingerprint"');
    expect(html).toContain('value="FP-INTERACTION"');
  });

  it("does not show a colleague's acknowledgement as settled", () => {
    // The projection reports the viewer's own state only, so from the
    // panel's side "somebody else acknowledged it" is indistinguishable
    // from "nobody has" — and it must stay actionable.
    const html = render([finding({ fingerprint: "FP-INTERACTION", acknowledgedByViewer: false })]);

    expect(html).not.toContain("Acknowledged by you");
    expect(html).toContain(ACK_ACTION);
    expect(html).toContain("Acknowledgements are per-pharmacist");
  });

  it("replaces the control with a settled badge once the viewer has acknowledged", () => {
    const html = render([finding({ fingerprint: "FP-INTERACTION", acknowledgedByViewer: true })]);

    expect(html).toContain("Acknowledged by you");
    expect(html).not.toContain("<form");
    expect(html).toContain("Nothing outstanding for you");
  });

  it("shows a COVERED patient-record gap as acknowledged for the patient — dated, never silent", () => {
    // The gate will pass this gap without a fresh click. A panel that
    // simply rendered no prompt would make a suppressed safety prompt
    // read as a clean screen, so the coverage is stated with its date
    // and the control is withdrawn.
    const html = render([
      finding({
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        fingerprint: "FP-ALLERGY-GAP",
        acknowledgeable: false,
        patientScopeCoverage: {
          kind: "COVERED",
          acknowledgedAt: new Date("2026-07-01T10:00:00.000Z"),
        },
      }),
    ]);

    expect(html).toContain("Acknowledged for this patient by you");
    expect(html).toContain("2026-07-01 10:00:00Z");
    expect(html).toContain("until the patient");
    expect(html).not.toContain("<form");
    expect(html).toContain("Nothing outstanding for you");
  });

  it("explains a SUPERSEDED acknowledgement and re-offers the control", () => {
    // The re-arm, as the pharmacist meets it: the prompt is back, and
    // the panel says why — the record changed after their judgement —
    // rather than looking like a system that forgot.
    const html = render([
      finding({
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        fingerprint: "FP-ALLERGY-GAP",
        patientScopeCoverage: {
          kind: "SUPERSEDED",
          lastAcknowledgedAt: new Date("2026-07-01T10:00:00.000Z"),
        },
      }),
    ]);

    expect(html).toContain("record has changed since");
    expect(html).toContain("2026-07-01 10:00:00Z");
    expect(html).toContain(ACK_ACTION);
    expect(html).toContain('value="FP-ALLERGY-GAP"');
    expect(html).not.toContain("Acknowledged for this patient by you");
  });

  it("asks nothing of the pharmacist for an INFORMATIONAL finding", () => {
    const html = render([
      finding({ severity: "MINOR", disposition: "INFORMATIONAL", fingerprint: "FP-MINOR" }),
    ]);
    expect(html).not.toContain("<form");
    expect(html).toContain("Informational");
  });

  it("withholds every control when the operator cannot approve", () => {
    const html = render([finding()], { kind: "NO_PERMISSION" });
    expect(html).not.toContain("<form");
    expect(html).toContain("pv1.approve");
  });

  it("withholds every control once the review is closed", () => {
    const html = render([finding()], { kind: "REVIEW_CLOSED" });
    expect(html).not.toContain("<form");
    expect(html).toContain("not in PV1 review");
  });

  it("leads with the hard stop and never offers acknowledgement as the way out of one", () => {
    const html = render([
      finding({
        findingId: "f-stop",
        disposition: "HARD_STOP",
        severity: "CONTRAINDICATED",
        certainty: "DEFINITE",
        fingerprint: "FP-HARD-STOP",
      }),
      finding({ findingId: "f-ack", fingerprint: "FP-ACK" }),
    ]);

    // The acknowledgeable finding keeps its control; the hard stop
    // contributes none, so exactly one form exists and it carries the
    // acknowledgeable fingerprint.
    expect(countOf(html, "<form")).toBe(1);
    expect(html).toContain('value="FP-ACK"');
    expect(html).not.toContain('value="FP-HARD-STOP"');
    // The banner must not send the pharmacist off to acknowledge.
    expect(html).toContain("Approval is not available for this order");
    expect(html).not.toContain("Approval will be refused until you acknowledge");
  });

  it("separates the three audiences and puts the platform gaps last", () => {
    const html = render([
      finding({ findingId: "f-clinical", fingerprint: "FP-CLINICAL", group: "CLINICAL" }),
      finding({
        findingId: "f-coverage",
        fingerprint: "FP-COVERAGE",
        code: "SCR_KNOWLEDGE_UNAVAILABLE",
        kind: "SCREENING_GAP",
        group: "PRESCRIPTION_COVERAGE",
      }),
      finding({
        findingId: "f-platform",
        fingerprint: "FP-PLATFORM",
        code: "SCR_DOSE_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        group: "PLATFORM_CAPABILITY",
      }),
    ]);

    const clinical = html.indexOf("Findings on this prescription");
    const coverage = html.indexOf("Checks that could not run for this prescription");
    const platform = html.indexOf("Checks Pharmax cannot perform yet");
    expect(clinical).toBeGreaterThan(-1);
    expect(coverage).toBeGreaterThan(clinical);
    expect(platform).toBeGreaterThan(coverage);

    // Each block's button states what it records, so the habit built
    // on the bottom block does not transfer to the top one.
    expect(html).toContain("Acknowledge finding");
    expect(html).toContain("Acknowledge unchecked drug");
    expect(html).toContain("Acknowledge unavailable check");
  });

  it("omits a block nobody has findings in", () => {
    const html = render([finding()]);
    expect(html).toContain("Findings on this prescription");
    expect(html).not.toContain("Checks Pharmax cannot perform yet");
  });

  it("says an unscreened order is unscreened rather than showing an empty clean panel", () => {
    const html = renderToStaticMarkup(
      createElement(ScreeningFindingsPanel, {
        orderId: ORDER_ID,
        screening: null,
        gate: { kind: "OPEN" },
      })
    );
    expect(html).toContain("Not screened yet");
    expect(html).not.toContain("<form");
  });
});
