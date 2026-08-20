// DEA number validation tests.
//
// The checksum vectors below are constructed from the algorithm rather
// than copied from any real registration: (d1+d3+d5) + 2*(d2+d4+d6),
// check digit = last digit. Using a real prescriber's DEA number as a
// fixture would put a live controlled-substance credential in the
// repository, which is exactly the leak `redactFields` exists to
// prevent everywhere else.
//
// Worked example for AB1234563:
//   odd  = 1 + 3 + 5 = 9
//   even = 2 + 4 + 6 = 12
//   9 + 24 = 33 -> check digit 3. Matches the trailing 3.

import { describe, expect, it } from "vitest";

import {
  DEA_INVALID_CHECKSUM,
  DEA_INVALID_FORMAT,
  DEA_LAST_NAME_MISMATCH,
  DEA_UNKNOWN_REGISTRANT_TYPE,
  canPrescribe,
  validateDeaNumber,
} from "./validate-dea-number.js";

/** Check digit for the first six digits, per the documented algorithm. */
function checkDigitFor(sixDigits: string): number {
  const d = [...sixDigits].map(Number);
  return (d[0]! + d[2]! + d[4]! + 2 * (d[1]! + d[3]! + d[5]!)) % 10;
}

function synth(prefix: string, sixDigits: string): string {
  return `${prefix}${sixDigits}${checkDigitFor(sixDigits)}`;
}

describe("validateDeaNumber — checksum", () => {
  it("accepts a number whose check digit is correct", () => {
    const result = validateDeaNumber({ deaNumber: "AB1234563" });
    expect(result.ok).toBe(true);
  });

  it("agrees with the algorithm across a spread of six-digit bodies", () => {
    for (const body of ["000000", "111111", "123456", "999999", "504321", "870112"]) {
      const valid = synth("BC", body);
      expect(validateDeaNumber({ deaNumber: valid }).ok, `${valid} should pass`).toBe(true);
    }
  });

  it("rejects every single-digit corruption of the check digit", () => {
    // The check digit is the whole point; a number that passes with the
    // wrong one would make this module decorative.
    for (let wrong = 0; wrong <= 9; wrong += 1) {
      if (wrong === 3) continue;
      const result = validateDeaNumber({ deaNumber: `AB123456${wrong}` });
      expect(result.ok, `AB123456${wrong} should fail`).toBe(false);
      if (!result.ok) expect(result.code).toBe(DEA_INVALID_CHECKSUM);
    }
  });

  it("catches an adjacent transposition in the body", () => {
    // 123456 -> 124356 swaps two digits across the odd/even split, so
    // the weighted sum moves. This is the typo class the check digit
    // exists to catch.
    expect(validateDeaNumber({ deaNumber: "AB1234563" }).ok).toBe(true);
    expect(validateDeaNumber({ deaNumber: "AB1243563" }).ok).toBe(false);
  });

  it("does not disclose the expected check digit in the failure message", () => {
    const result = validateDeaNumber({ deaNumber: "AB1234560" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Telling the operator the right digit turns the validator into
      // an oracle for forging a number that passes.
      expect(result.message).not.toMatch(/\b3\b/);
    }
  });
});

describe("validateDeaNumber — format", () => {
  it.each([
    ["", "empty"],
    ["AB123456", "six digits"],
    ["AB12345678", "eight digits"],
    ["1B1234563", "digit in the first position"],
    ["A11234563", "a digit other than 9 in the second position"],
    ["ABC123456", "three letters"],
    ["AB-123456", "punctuation"],
  ])("rejects %s (%s)", (value) => {
    const result = validateDeaNumber({ deaNumber: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DEA_INVALID_FORMAT);
  });

  it("accepts 9 in the second position — a business-name registration", () => {
    // The existing regex in register-provider.ts is `^[A-Z]{2}\d{7}$`,
    // which refuses these outright. Pinned here so migrating those
    // commands onto this module cannot quietly reintroduce it.
    const result = validateDeaNumber({ deaNumber: synth("A9", "123456") });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lastNameInitial).toBe("9");
  });

  it("normalizes case and surrounding whitespace", () => {
    const result = validateDeaNumber({ deaNumber: "  ab1234563  " });
    expect(result.ok).toBe(true);
    // Callers store the normalized value, so a lowercase paste and a
    // clean entry converge on one row rather than two.
    if (result.ok) expect(result.deaNumber).toBe("AB1234563");
  });
});

describe("validateDeaNumber — registrant type", () => {
  it("classifies M as a mid-level practitioner", () => {
    const result = validateDeaNumber({ deaNumber: synth("MB", "123456") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registrantType).toBe("MID_LEVEL_PRACTITIONER");
      expect(result.canPrescribe).toBe(true);
    }
  });

  it.each(["A", "B", "C", "F", "G"])("classifies %s as a practitioner", (letter) => {
    const result = validateDeaNumber({ deaNumber: synth(`${letter}B`, "123456") });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.registrantType).toBe("PRACTITIONER");
  });

  it.each(["P", "R", "S", "T", "U"])("classifies %s as a narcotic treatment program", (letter) => {
    const result = validateDeaNumber({ deaNumber: synth(`${letter}B`, "123456") });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.registrantType).toBe("NARCOTIC_TREATMENT_PROGRAM");
  });

  it("recognizes a legacy X number rather than rejecting it", () => {
    // The MAT Act eliminated the X-waiver in December 2022. Existing
    // numbers are history worth recording, not errors.
    const result = validateDeaNumber({ deaNumber: synth("XB", "123456") });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.registrantType).toBe("DATA_WAIVED_LEGACY");
  });

  it.each(["D", "E", "H", "J", "K", "L", "N", "Q"])("marks %s as non-prescribing", (letter) => {
    const result = validateDeaNumber({ deaNumber: synth(`${letter}B`, "123456") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registrantType).toBe("NON_PRESCRIBING");
      // A distributor's registration on a prescriber record is a
      // data-entry error, not a credential.
      expect(result.canPrescribe).toBe(false);
    }
  });

  it.each(["I", "O", "V", "W", "Y", "Z"])("rejects %s as not a registrant letter", (letter) => {
    const result = validateDeaNumber({ deaNumber: synth(`${letter}B`, "123456") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DEA_UNKNOWN_REGISTRANT_TYPE);
  });

  it("exposes canPrescribe as a standalone predicate", () => {
    expect(canPrescribe("PRACTITIONER")).toBe(true);
    expect(canPrescribe("MID_LEVEL_PRACTITIONER")).toBe(true);
    expect(canPrescribe("NON_PRESCRIBING")).toBe(false);
  });
});

describe("validateDeaNumber — surname cross-check", () => {
  it("accepts a number whose second letter matches the surname", () => {
    const result = validateDeaNumber({ deaNumber: "AB1234563", lastName: "Brennan" });
    expect(result.ok).toBe(true);
  });

  it("rejects a number belonging to a different prescriber", () => {
    // The case a checksum cannot catch: a perfectly valid DEA number
    // pasted from the wrong chart.
    const result = validateDeaNumber({ deaNumber: "AB1234563", lastName: "Okonkwo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DEA_LAST_NAME_MISMATCH);
  });

  it("treats a second letter of 9 as always matching", () => {
    // The DEA issues 9 to registrants without a conventional surname
    // initial; it is not a mismatch against any name.
    const result = validateDeaNumber({ deaNumber: synth("A9", "123456"), lastName: "Brennan" });
    expect(result.ok).toBe(true);
  });

  it("skips the check when no surname is supplied", () => {
    expect(validateDeaNumber({ deaNumber: "AB1234563" }).ok).toBe(true);
  });

  it("is case- and whitespace-insensitive about the surname", () => {
    expect(validateDeaNumber({ deaNumber: "AB1234563", lastName: "  brennan" }).ok).toBe(true);
  });

  it("skips the check for an empty surname rather than failing", () => {
    expect(validateDeaNumber({ deaNumber: "AB1234563", lastName: "   " }).ok).toBe(true);
  });
});
