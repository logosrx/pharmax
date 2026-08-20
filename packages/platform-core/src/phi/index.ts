// PHI tripwire — pattern scan for text that is about to cross a
// boundary it must cross clean: a model-provider prompt, an
// append-only ledger row, an Object-Locked evidence artifact.
//
// What this is, and what it is not.
//
// It is NOT a PHI detector. Reliable PHI detection in free text is
// unsolved, and a module that claimed to do it would be making
// exactly the kind of unearned compliance claim this codebase
// forbids. A determined caller can defeat every pattern below.
//
// It IS a tripwire for the realistic failure: an engineer six months
// from now types "patient Jane Doe, DOB 1962-07-04, order stuck"
// into a break-glass reason, or widens a prompt builder to include
// "the order that triggered this finding", because it is helpful and
// the prohibition lives in a comment they did not read. That mistake
// has a recognizable shape — dates of birth, SSNs, MRN-looking
// identifiers, phone numbers, "patient:" labels — and catching the
// recognizable shape at runtime converts a silent HIPAA disclosure
// into a loud, immediate refusal.
//
// The real control at every consuming boundary remains structural
// (closed reason codes, builders that read only non-PHI planes); the
// tripwire is the belt to those suspenders. Consumers own their own
// refusal wording and error codes — this module only reports which
// rules fired, and never the matched text.
//
// Failure mode at every call site should be fail-closed: on a hit,
// refuse the write or the send. A false positive costs someone a
// rewording; a false negative puts patient data somewhere it can
// never be deleted from.

// Redaction lives next door, for boundaries that cannot fail closed.
// See `./redact.ts` for why the two are separate.
export { redactAndCap, redactPhiPatterns } from "./redact.js";

export interface TripwireHit {
  /** Which rule fired. Never contains the matched text. */
  readonly rule: string;
  readonly explanation: string;
}

interface TripwireRule {
  readonly rule: string;
  readonly explanation: string;
  readonly pattern: RegExp;
}

/**
 * Patterns chosen for the shapes that show up when a non-PHI surface
 * is accidentally widened to operational data. Each is anchored
 * tightly enough that ordinary control prose does not trip it —
 * "CC6.1-2", "45 CFR 164.312", and "ADR-0025" must all pass.
 */
const RULES: readonly TripwireRule[] = [
  {
    rule: "ssn",
    explanation: "Looks like a US Social Security Number.",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    rule: "date_of_birth_label",
    explanation: "Carries an explicit date-of-birth label.",
    pattern: /\b(date of birth|dob)\b\s*[:=]/i,
  },
  {
    rule: "patient_label",
    explanation: "Carries an explicit patient identifier label.",
    pattern: /\b(patient|mrn|medical record (number|no))\b\s*[:=#]/i,
  },
  {
    rule: "patient_name_field",
    explanation: "Carries a patient name field.",
    pattern: /\b(patient|member|subscriber)[_ ]?(first|last|full)?[_ ]?name\b/i,
  },
  {
    rule: "us_phone",
    explanation: "Looks like a US phone number.",
    pattern: /\b(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
  },
  {
    rule: "email_address",
    explanation:
      "Contains an email address. Operator emails are workforce data, but no guarded " +
      "surface needs a raw address embedded in free text, so all are refused.",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/,
  },
  {
    rule: "rx_number",
    explanation: "Carries a prescription number label.",
    pattern: /\b(rx|prescription)[_ ]?(number|no|#)\b\s*[:=#]?/i,
  },
  {
    rule: "twentieth_century_iso_date",
    explanation:
      "Contains a bare 20th-century ISO date. Operational timestamps in this system are all " +
      "recent, so a 19xx date here is far more likely to be a birth date — and an unlabelled " +
      "one, which the date-of-birth label rule would miss.",
    // Known false positive: a policy section that spells out HIPAA's
    // enactment date as 1996-08-21 will trip this. That is the
    // intended trade. The failure is loud, immediate, and fixed by
    // writing "August 1996" instead; the miss it prevents is an
    // unlabelled DOB reaching a store it can never be deleted from.
    pattern: /\b(?:1[0-8]\d{2}|19\d{2})-\d{2}-\d{2}\b/,
  },
];

/** Report every rule that fires. Does not throw. */
export function scanForPhi(text: string): readonly TripwireHit[] {
  const hits: TripwireHit[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      hits.push({ rule: rule.rule, explanation: rule.explanation });
    }
  }
  return hits;
}
