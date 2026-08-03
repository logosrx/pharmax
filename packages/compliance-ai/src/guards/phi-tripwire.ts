// PHI tripwire — last check before any text leaves for a model
// provider.
//
// What this is, and what it is not.
//
// It is NOT a PHI detector. Reliable PHI detection in free text is
// unsolved, and a package that claimed to do it would be making
// exactly the kind of unearned compliance claim this codebase
// forbids. A determined caller can defeat every pattern below.
//
// It IS a tripwire for the realistic failure: an engineer six months
// from now adds "and here is the order that triggered this finding"
// to a prompt builder, because it makes the draft better and the
// prohibition lives in a comment they did not read. That mistake has
// a recognizable shape — dates of birth, SSNs, MRN-looking
// identifiers, phone numbers, "patient:" labels — and catching the
// recognizable shape at runtime converts a silent HIPAA disclosure
// into a loud test failure.
//
// The real control remains structural: prompt inputs are assembled by
// builders in this package that read only the compliance plane, and
// no probe or control record contains a patient column. The tripwire
// is the belt to that suspenders, positioned so that it fires in CI
// the first time someone widens an input.
//
// Failure mode is deliberately fail-closed: on a hit, the call is
// refused. A false positive blocks a policy paragraph from being
// drafted, which costs someone five minutes. A false negative sends
// patient data to a vendor with no BAA covering it, which is a
// reportable breach.

/** Thrown when a prompt looks like it carries patient data. */
export const COMPLIANCE_AI_PHI_TRIPWIRE = "COMPLIANCE_AI_PHI_TRIPWIRE";

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
 * Patterns chosen for the shapes that show up when compliance context
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
      "Contains an email address. Operator emails are workforce data, but this layer has " +
      "no need to send any address to a model, so all are refused.",
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
      "Contains a bare 20th-century ISO date. Compliance timestamps in this system are all " +
      "recent, so a 19xx date here is far more likely to be a birth date — and an unlabelled " +
      "one, which the date-of-birth label rule would miss.",
    // Known false positive: a policy section that spells out HIPAA's
    // enactment date as 1996-08-21 will trip this. That is the
    // intended trade. The failure is loud, immediate, and fixed by
    // writing "August 1996" instead; the miss it prevents is an
    // unlabelled DOB column reaching a vendor with no BAA.
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

/**
 * Refuse the call if anything fires.
 *
 * The thrown error names the rules but never quotes the matched text:
 * an error message is logged, and logging the thing we just decided
 * was too sensitive to send would defeat the point.
 */
export function assertNoPhi(text: string, context: string): void {
  const hits = scanForPhi(text);
  if (hits.length === 0) return;

  throw new Error(
    `${COMPLIANCE_AI_PHI_TRIPWIRE}: refusing to send "${context}" to a model provider. ` +
      `Matched ${hits.length} rule(s): ${hits.map((h) => h.rule).join(", ")}. ` +
      `${hits.map((h) => h.explanation).join(" ")} ` +
      `Prompt inputs for this layer must come from the compliance plane only — control ` +
      `metadata, probe output, framework codes. If this is a false positive, narrow the ` +
      `input rather than widening the rule.`
  );
}
