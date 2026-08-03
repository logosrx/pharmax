// Tests for the transcription error wording.
//
// The first suite is the one that matters: it pins the locally
// mirrored code list against the constants `CreatePrescription`
// actually throws. Renaming a code in the command without renaming it
// here would otherwise degrade a precise, actionable message into the
// generic "report this to your administrator" fallback — a silent
// regression that no type check catches, because both sides are just
// strings.

import {
  RX_CLINIC_NOT_FOUND,
  RX_CONTROLLED_AUTHORIZATION_INVALID,
  RX_DATE_WRITTEN_IN_FUTURE,
  RX_EARLIEST_FILL_BEFORE_WRITTEN,
  RX_EXPIRES_NOT_AFTER_WRITTEN,
  RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON,
  RX_NDC_INVALID,
  RX_NUMBER_COLLISION,
  RX_PATIENT_CLINIC_MISMATCH,
  RX_PATIENT_NOT_ACTIVE,
  RX_PATIENT_NOT_FOUND,
  RX_PROVIDER_DEA_REQUIRED,
  RX_PROVIDER_INACTIVE,
  RX_PROVIDER_NOT_FOUND,
  RX_SCHEDULE_CATALOG_MISMATCH,
  RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC,
} from "@pharmax/orders";
import { describe, expect, it } from "vitest";

import {
  CREATE_PRESCRIPTION_ERROR_CODES,
  describeCreatePrescriptionError,
} from "./rx-transcription-errors.js";

/** Every code the command declares, read from the command itself. */
const COMMAND_CODES: ReadonlyArray<string> = [
  RX_CLINIC_NOT_FOUND,
  RX_PATIENT_NOT_FOUND,
  RX_PATIENT_CLINIC_MISMATCH,
  RX_PATIENT_NOT_ACTIVE,
  RX_PROVIDER_NOT_FOUND,
  RX_PROVIDER_INACTIVE,
  RX_PROVIDER_DEA_REQUIRED,
  RX_NDC_INVALID,
  RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC,
  RX_SCHEDULE_CATALOG_MISMATCH,
  RX_CONTROLLED_AUTHORIZATION_INVALID,
  RX_DATE_WRITTEN_IN_FUTURE,
  RX_EXPIRES_NOT_AFTER_WRITTEN,
  RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON,
  RX_EARLIEST_FILL_BEFORE_WRITTEN,
  RX_NUMBER_COLLISION,
];

describe("code coverage against the command", () => {
  it("mirrors exactly the codes CreatePrescription throws", () => {
    expect([...CREATE_PRESCRIPTION_ERROR_CODES].sort()).toEqual([...COMMAND_CODES].sort());
  });

  it.each(COMMAND_CODES)("has actionable wording for %s", (code) => {
    const described = describeCreatePrescriptionError(`${code}: some command-side message`);
    expect(described.code).toBe(code);
    expect(described.title.length).toBeGreaterThan(0);
    // The generic fallback would pass a "non-empty" assertion, so pin
    // that this code did NOT fall through to it.
    expect(described.title).not.toBe("The prescription wasn't saved");
  });
});

describe("describeCreatePrescriptionError", () => {
  it("reads the code out of the `CODE: message` redirect payload", () => {
    const described = describeCreatePrescriptionError(
      "RX_PATIENT_NOT_ACTIVE: Patient is deceased and cannot receive a new prescription."
    );
    expect(described.code).toBe("RX_PATIENT_NOT_ACTIVE");
    expect(described.title).toBe("The patient's record isn't active");
  });

  it("accepts a bare code with no message", () => {
    expect(describeCreatePrescriptionError("RX_NDC_INVALID").title).toBe(
      "That NDC isn't a valid National Drug Code"
    );
  });

  it("does not echo the command's own message back to the operator", () => {
    const described = describeCreatePrescriptionError("RX_NDC_INVALID: raw command text");
    expect(described.guidance).not.toContain("raw command text");
  });

  it("keeps an unrecognized code visible under generic wording", () => {
    const described = describeCreatePrescriptionError("RX_BI_REQUIRED_NULL: crypto misconfigured");
    expect(described.code).toBe("RX_BI_REQUIRED_NULL");
    expect(described.title).toBe("The prescription wasn't saved");
  });

  it("labels a schema rejection as a form problem, not an infrastructure one", () => {
    const described = describeCreatePrescriptionError("COMMAND_INPUT_INVALID: expected YYYY-MM-DD");
    expect(described.title).toBe("Some entries didn't pass validation");
  });

  it("survives an empty payload", () => {
    expect(describeCreatePrescriptionError("").code).toBe("UNKNOWN");
  });
});

describe("federal citations", () => {
  it.each([
    RX_PROVIDER_DEA_REQUIRED,
    RX_CONTROLLED_AUTHORIZATION_INVALID,
    RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON,
  ])("cites the rule behind %s", (code) => {
    expect(describeCreatePrescriptionError(code).citation).toMatch(/^21 CFR /);
  });

  it.each([RX_NDC_INVALID, RX_PATIENT_NOT_FOUND, RX_NUMBER_COLLISION])(
    "does not invent a citation for %s",
    (code) => {
      expect(describeCreatePrescriptionError(code).citation).toBeUndefined();
    }
  );
});
