// DEA registration number validation — pure, offline, no dependencies.
//
// `register-provider.ts` has carried a note since it was written that
// it "accepts the regex shape and defers the checksum check to a future
// hardening pass". This is that pass.
//
// WHAT THIS CAN AND CANNOT TELL YOU. There is no free authoritative DEA
// registration API; the Active Registrant file is a paid data licence.
// So this module answers three questions that are answerable offline:
//
//   1. Is the number internally consistent? The seventh digit is a
//      check digit over the first six, so a single-digit typo or an
//      adjacent transposition is caught with ~90% probability.
//   2. What kind of registrant does it claim to be? The first letter
//      encodes that, and it is what distinguishes a mid-level
//      practitioner from a physician.
//   3. Does it plausibly belong to this person? The second letter is
//      the registrant's last-name initial, so a number pasted from the
//      wrong chart usually fails.
//
// What it cannot tell you is whether the registration is real, current,
// or unrevoked. Only the DEA knows that. `ProviderDeaRegistration`
// carries a recorded expiry for the part we can track, and
// `DeaRegistryVerifier` is the seam a licensed file would plug into.
// Do not let a PASS here be read as "verified with the DEA".
//
// Checksum algorithm (21 CFR 1301 registration numbering, and the
// arithmetic every pharmacy system implements):
//
//   Given digits d1..d7,
//     sum = (d1 + d3 + d5) + 2 * (d2 + d4 + d6)
//     d7 must equal sum mod 10.

/** Outcome codes. Exported so callers can branch without string literals. */
export const DEA_INVALID_FORMAT = "DEA_INVALID_FORMAT";
export const DEA_INVALID_CHECKSUM = "DEA_INVALID_CHECKSUM";
export const DEA_UNKNOWN_REGISTRANT_TYPE = "DEA_UNKNOWN_REGISTRANT_TYPE";
export const DEA_LAST_NAME_MISMATCH = "DEA_LAST_NAME_MISMATCH";

export type DeaValidationFailureCode =
  | typeof DEA_INVALID_FORMAT
  | typeof DEA_INVALID_CHECKSUM
  | typeof DEA_UNKNOWN_REGISTRANT_TYPE
  | typeof DEA_LAST_NAME_MISMATCH;

/**
 * What the first letter claims the registrant is.
 *
 * Collapsed to the distinctions that change how Pharmax behaves, not
 * the full DEA taxonomy. The one that matters clinically is
 * MID_LEVEL_PRACTITIONER: an NP or PA whose prescriptive authority for
 * controlled substances is bounded by state law in ways a physician's
 * is not, which is why it is worth surfacing rather than flattening
 * into "practitioner".
 */
export type DeaRegistrantType =
  /** A, B, C, F, G — physician, dentist, hospital, clinic, teaching institution. */
  | "PRACTITIONER"
  /** M — nurse practitioner, physician assistant, and other mid-levels. */
  | "MID_LEVEL_PRACTITIONER"
  /** P, R, S, T, U — narcotic treatment / detoxification programs. */
  | "NARCOTIC_TREATMENT_PROGRAM"
  /**
   * X — legacy DATA-waived buprenorphine prescribing. The MAT Act
   * (Consolidated Appropriations Act, 2023) eliminated the X-waiver
   * requirement in December 2022, so a number beginning X is valid
   * history rather than a current credential. Recognized, not rejected.
   */
  | "DATA_WAIVED_LEGACY"
  /** D, E, H, J, K, L, N, Q — manufacturers, distributors, labs, importers. */
  | "NON_PRESCRIBING";

const REGISTRANT_TYPE_BY_LETTER: Readonly<Record<string, DeaRegistrantType>> = Object.freeze({
  A: "PRACTITIONER",
  B: "PRACTITIONER",
  C: "PRACTITIONER",
  F: "PRACTITIONER",
  G: "PRACTITIONER",
  M: "MID_LEVEL_PRACTITIONER",
  P: "NARCOTIC_TREATMENT_PROGRAM",
  R: "NARCOTIC_TREATMENT_PROGRAM",
  S: "NARCOTIC_TREATMENT_PROGRAM",
  T: "NARCOTIC_TREATMENT_PROGRAM",
  U: "NARCOTIC_TREATMENT_PROGRAM",
  X: "DATA_WAIVED_LEGACY",
  D: "NON_PRESCRIBING",
  E: "NON_PRESCRIBING",
  H: "NON_PRESCRIBING",
  J: "NON_PRESCRIBING",
  K: "NON_PRESCRIBING",
  L: "NON_PRESCRIBING",
  N: "NON_PRESCRIBING",
  Q: "NON_PRESCRIBING",
});

/**
 * Registrant types that may write a prescription. NON_PRESCRIBING is
 * excluded: a distributor's registration on a prescriber record is a
 * data-entry error, not a credential.
 */
const PRESCRIBING_TYPES: ReadonlySet<DeaRegistrantType> = new Set<DeaRegistrantType>([
  "PRACTITIONER",
  "MID_LEVEL_PRACTITIONER",
  "NARCOTIC_TREATMENT_PROGRAM",
  "DATA_WAIVED_LEGACY",
]);

export function canPrescribe(type: DeaRegistrantType): boolean {
  return PRESCRIBING_TYPES.has(type);
}

/**
 * Letter, then letter-or-`9`, then seven digits.
 *
 * The second position is NOT `[A-Z]`. It holds the registrant's
 * surname initial, or the digit `9` when the registration is under a
 * business name. `register-provider.ts` and `update-provider.ts` both
 * use `^[A-Z]{2}\d{7}$` today, which silently refuses every such
 * number; migrating those commands onto this module fixes that.
 */
const DEA_SHAPE = /^[A-Z][A-Z9]\d{7}$/;

export interface DeaValidationFailure {
  readonly ok: false;
  readonly code: DeaValidationFailureCode;
  readonly message: string;
}

export interface DeaValidationSuccess {
  readonly ok: true;
  /** Normalized: trimmed and uppercased. Store THIS, not the raw input. */
  readonly deaNumber: string;
  readonly registrantType: DeaRegistrantType;
  /** False for distributors, labs, and importers — see PRESCRIBING_TYPES. */
  readonly canPrescribe: boolean;
  /**
   * The second letter. `9` is legitimate: it is what the DEA issues to
   * registrants without a conventional surname initial (businesses, and
   * some older individual registrations), so it is never a mismatch.
   */
  readonly lastNameInitial: string;
}

export type DeaValidationResult = DeaValidationSuccess | DeaValidationFailure;

export interface ValidateDeaNumberInput {
  readonly deaNumber: string;
  /**
   * Optional cross-check. When supplied, the second letter must match
   * this surname's initial (or be `9`). This catches the number pasted
   * from the wrong chart, which a checksum cannot — a valid DEA number
   * belonging to a different prescriber passes every other test here.
   */
  readonly lastName?: string;
}

/**
 * Validate a DEA registration number offline.
 *
 * Returns a discriminated result rather than throwing: callers differ
 * in what a failure means. A command refuses; a bulk import records and
 * continues; the UI shows an inline hint before submit.
 */
export function validateDeaNumber(input: ValidateDeaNumberInput): DeaValidationResult {
  const deaNumber = input.deaNumber.trim().toUpperCase();

  if (!DEA_SHAPE.test(deaNumber)) {
    return {
      ok: false,
      code: DEA_INVALID_FORMAT,
      message:
        "A DEA number is a letter, then a letter or 9, then seven digits — for example AB1234563.",
    };
  }

  const registrantLetter = deaNumber[0]!;
  const lastNameInitial = deaNumber[1]!;
  const registrantType = REGISTRANT_TYPE_BY_LETTER[registrantLetter];

  if (registrantType === undefined) {
    return {
      ok: false,
      code: DEA_UNKNOWN_REGISTRANT_TYPE,
      message: `"${registrantLetter}" is not a DEA registrant-type letter.`,
    };
  }

  const digits = [...deaNumber.slice(2)].map((c) => Number(c));
  const oddSum = digits[0]! + digits[2]! + digits[4]!;
  const evenSum = digits[1]! + digits[3]! + digits[5]!;
  const expectedCheckDigit = (oddSum + 2 * evenSum) % 10;

  if (digits[6] !== expectedCheckDigit) {
    return {
      ok: false,
      code: DEA_INVALID_CHECKSUM,
      // No "expected X" in the message: it would turn a validation
      // error into an oracle for forging a number that passes.
      message: "This DEA number's check digit is wrong. Re-enter it from the registration.",
    };
  }

  if (input.lastName !== undefined && lastNameInitial !== "9") {
    const expectedInitial = input.lastName.trim().charAt(0).toUpperCase();
    if (expectedInitial.length > 0 && lastNameInitial !== expectedInitial) {
      return {
        ok: false,
        code: DEA_LAST_NAME_MISMATCH,
        message: `This DEA number's second letter is "${lastNameInitial}", which does not match the prescriber's surname. Check it belongs to this prescriber.`,
      };
    }
  }

  return {
    ok: true,
    deaNumber,
    registrantType,
    canPrescribe: canPrescribe(registrantType),
    lastNameInitial,
  };
}
