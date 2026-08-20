// PHI pattern redaction — the sibling of the tripwire in `./index.ts`,
// for boundaries that must not refuse.
//
// The tripwire and this module answer the same question and act on the
// answer differently, which is why they live together but stay
// separate:
//
//   - `scanForPhi` is for boundaries that CAN fail closed. A break-glass
//     reason, a model prompt, an Object-Locked evidence row: refusing
//     the write costs someone a rewording, so refusal is right.
//
//   - `redactPhiPatterns` is for boundaries that CANNOT. Telemetry is
//     the case: dropping an error report because it might contain PHI
//     trades a disclosure risk for a blindness risk, and a system whose
//     error reporting silently discards its worst errors is not safer.
//     So redact and forward.
//
// Neither is a PHI detector. Reliable detection in free text is
// unsolved, and claiming otherwise would be the kind of unearned
// compliance claim this codebase forbids. Both catch the RECOGNIZABLE
// shape of the realistic mistake — which for telemetry is not an
// engineer logging a patient name on purpose, but a third party's error
// message arriving with one already in it. A carrier's API is not
// written by us and does not know our redaction rules.
//
// Trade-off, stated once: these patterns are deliberately blunt. A
// false positive costs a little debugging context. A false negative is
// a disclosure to a third party. When those are the two choices,
// over-redaction wins.

/**
 * Shapes PHI takes inside free text, and the stable token each is
 * replaced with.
 *
 * Order matters. The SSN rule runs before the phone sweep so that
 * `123-45-6789` is not partially consumed, and the street-address sweep
 * runs before the bare-date rules so a house number is not mistaken for
 * anything else.
 */
const PHI_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  // Most specific digit shapes first, so a looser rule cannot consume
  // part of one and leave a fragment behind.
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\b\d{5}-\d{4}\b/g, "[zip]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  // The boundary here is a negative lookbehind rather than `\b`, because
  // `\b` sits between two word characters and a leading `(` is not one —
  // anchoring with `\b` left the paren stranded outside the match,
  // emitting `([phone]`. Excluding a preceding digit or hyphen also
  // stops the rule reaching into a UUID segment.
  [/(?<![\d-])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g, "[phone]"],
  [
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy)\b\.?/gi,
    "[address]",
  ],
  // A bare calendar date is the shape a date of birth takes. The
  // negative lookahead spares ISO timestamps, which are pure debugging
  // value and never a birth date.
  [/\b\d{4}-\d{2}-\d{2}\b(?!T)/g, "[date]"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]"],
] as ReadonlyArray<readonly [RegExp, string]>);

/**
 * Sweep PHI shapes out of a free-text string, replacing each with a
 * stable token.
 *
 * The position this replaced was that exception messages could not be
 * scrubbed because doing so "would destroy the grouping fingerprint",
 * leaving call-site discipline as the only control and a length cap as
 * the backstop. Call-site discipline is exactly the control that fails:
 * nobody writes `throw new Error(patient.firstName)` on purpose, and a
 * carrier's API error message is not written by us at all.
 *
 * Replacing a match with a STABLE token is what makes this safe for
 * grouping, and in fact improves it. `Recipient jane@x.com not found`
 * and `Recipient bob@y.com not found` are two Sentry issues today;
 * redacted, they are one. Variable content is precisely what should not
 * be in a fingerprint.
 */
export function redactPhiPatterns(text: string): string {
  let out = text;
  for (const [pattern, token] of PHI_PATTERNS) {
    // Each regex is a module-level literal carrying the `g` flag, so
    // `lastIndex` must not leak between calls. `String.replace` with a
    // global regex resets it, but reassigning keeps that explicit.
    out = out.replace(pattern, token);
  }
  return out;
}

/**
 * Redact, then cap at `maxLength`.
 *
 * Capping first would let a truncation point split a match — `…Jane
 * Smith, 123 Main St` cut at 500 characters can leave `123 Mai`, which
 * no longer matches the address rule and is transmitted as-is. Redact
 * first and the cap only ever removes already-clean text.
 */
export function redactAndCap(text: string, maxLength: number): string {
  const redacted = redactPhiPatterns(text);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/** Exported for tests that need to assert on the rule set itself. */
export const __testing = { PHI_PATTERNS };
