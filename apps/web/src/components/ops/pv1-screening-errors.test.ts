// Wording tests for the PV1 screening refusals.
//
// The load-bearing assertion is the LAST one: a hard stop must never
// be described as something an acknowledgement clears. The console
// decides whether to offer "go and acknowledge them" from that flag,
// and offering it on a finding with no override path would send a
// pharmacist looking for a control this product deliberately does not
// build.
//
// The codes are imported from `@pharmax/verification` here as well as
// in the module under test, so a rename that broke the mapping would
// break this suite rather than quietly stop matching.

import { describe, expect, it } from "vitest";

import {
  PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED,
  PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE,
  PV1_SCREENING_FINDING_UNKNOWN,
  PV1_SCREENING_HARD_STOP,
  PV1_SCREENING_NOT_PERFORMED,
  PV1_SCREENING_STAGE_INVALID,
} from "@pharmax/verification";

import { describePv1ScreeningError } from "./pv1-screening-errors.js";

/** The shape `dispatchOpsCommand` puts in `?error=`. */
function payloadFor(code: string): string {
  return `${code}: Some message written for an API caller.`;
}

describe("describePv1ScreeningError", () => {
  it("returns null for anything that is not a screening refusal", () => {
    expect(describePv1ScreeningError(null)).toBeNull();
    expect(describePv1ScreeningError("")).toBeNull();
    expect(describePv1ScreeningError(payloadFor("SOD_VIOLATION"))).toBeNull();
    expect(describePv1ScreeningError(payloadFor("ORDER_VERSION_MISMATCH"))).toBeNull();
  });

  it("covers every screening refusal a console can meet", () => {
    for (const code of [
      PV1_SCREENING_HARD_STOP,
      PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED,
      PV1_SCREENING_FINDING_UNKNOWN,
      PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE,
      PV1_SCREENING_STAGE_INVALID,
      PV1_SCREENING_NOT_PERFORMED,
    ]) {
      const described = describePv1ScreeningError(payloadFor(code));
      expect(described, code).not.toBeNull();
      expect(described?.code).toBe(code);
      expect(described?.title.length).toBeGreaterThan(0);
      expect(described?.guidance.length).toBeGreaterThan(0);
    }
  });

  it("reads the code out of the redirect payload, with or without a message", () => {
    expect(describePv1ScreeningError(payloadFor(PV1_SCREENING_HARD_STOP))?.code).toBe(
      PV1_SCREENING_HARD_STOP
    );
    expect(describePv1ScreeningError(PV1_SCREENING_HARD_STOP)?.code).toBe(PV1_SCREENING_HARD_STOP);
    expect(describePv1ScreeningError(` ${PV1_SCREENING_HARD_STOP} : x`)?.code).toBe(
      PV1_SCREENING_HARD_STOP
    );
  });

  it("does not repeat the command's own message back at the operator", () => {
    const described = describePv1ScreeningError(
      `${PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED}: Clinical screening returned findings...`
    );
    expect(described?.guidance).not.toContain("Clinical screening returned findings...");
  });

  it("tells the pharmacist a missing acknowledgement is theirs alone to give", () => {
    const described = describePv1ScreeningError(payloadFor(PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED));
    expect(described?.resolvableByAcknowledgement).toBe(true);
    expect(described?.guidance).toContain("colleague");
  });

  it("never presents a hard stop as something an acknowledgement clears", () => {
    const described = describePv1ScreeningError(payloadFor(PV1_SCREENING_HARD_STOP));
    expect(described?.resolvableByAcknowledgement).toBe(false);
    expect(described?.tone).toBe("danger");
    expect(described?.guidance).toContain("nothing to acknowledge");
    expect(described?.guidance).toContain("Reject");
  });
});
