// Password policy — pure, synchronous structural evaluation plus an
// optional async breach check.
//
// Alignment: NIST SP 800-63B favors LENGTH and known-breach screening
// over mandatory composition rules. We default to that (long minimum,
// breach check, no forced character classes) but expose composition
// knobs because some SOC 2 auditors still expect them; they can be
// enabled per deployment without touching the engine.
//
// This module holds NO secrets and does NO hashing — it only judges
// plaintext strength. It is called by the ChangePassword / ResetPassword
// / SignUp commands before the hasher runs.

export interface BreachChecker {
  /**
   * True when the plaintext appears in a known-breached-password set.
   * Implementations SHOULD use a k-anonymity range query (e.g. the
   * HIBP model) so the full password never leaves the process.
   */
  isBreached(plaintext: string): Promise<boolean>;
}

export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  /** How many prior hashes the anti-reuse check compares against. */
  readonly historyDepth: number;
  /** When true, require at least `minCharacterClasses` of {upper,lower,digit,symbol}. */
  readonly requireCharacterClasses: boolean;
  readonly minCharacterClasses: number;
  /** Optional breach screen. Null/undefined disables it. */
  readonly breachChecker?: BreachChecker | null;
}

/** NIST-aligned default: length + breach, no forced composition. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = Object.freeze({
  minLength: 12,
  // Cap to bound the Argon2 input and prevent a long-string DoS. 128 is
  // well above any human-chosen or manager-generated password.
  maxLength: 128,
  historyDepth: 5,
  requireCharacterClasses: false,
  minCharacterClasses: 3,
  breachChecker: null,
});

export interface PasswordEvaluation {
  readonly ok: boolean;
  /** Human-readable, non-sensitive reasons. Safe to surface to an authenticated caller. */
  readonly violations: ReadonlyArray<string>;
}

/**
 * Synchronous structural checks: length bounds, optional composition,
 * and context reuse (the password must not contain the user's email
 * local-part or display name). Does NOT run the breach check — that is
 * async; call `checkNotBreached` separately.
 */
export function evaluatePasswordPolicy(input: {
  readonly plaintext: string;
  readonly policy: PasswordPolicy;
  /** Case-insensitive substrings the password must not contain (email, name). */
  readonly disallowedSubstrings?: ReadonlyArray<string>;
}): PasswordEvaluation {
  const { plaintext, policy } = input;
  const violations: string[] = [];

  if (plaintext.length < policy.minLength) {
    violations.push(`must be at least ${policy.minLength} characters`);
  }
  if (plaintext.length > policy.maxLength) {
    violations.push(`must be at most ${policy.maxLength} characters`);
  }

  if (policy.requireCharacterClasses) {
    const classes =
      (/[a-z]/.test(plaintext) ? 1 : 0) +
      (/[A-Z]/.test(plaintext) ? 1 : 0) +
      (/[0-9]/.test(plaintext) ? 1 : 0) +
      (/[^A-Za-z0-9]/.test(plaintext) ? 1 : 0);
    if (classes < policy.minCharacterClasses) {
      violations.push(
        `must include at least ${policy.minCharacterClasses} of: lowercase, uppercase, digit, symbol`
      );
    }
  }

  const haystack = plaintext.toLowerCase();
  for (const raw of input.disallowedSubstrings ?? []) {
    const needle = raw.trim().toLowerCase();
    if (needle.length >= 3 && haystack.includes(needle)) {
      violations.push("must not contain your name or email");
      break;
    }
  }

  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
}

/**
 * Runs the configured breach check (if any). Returns a violation list
 * so the caller can merge it with the structural evaluation. Fails
 * OPEN on checker error (the breach service being down must not block
 * a legitimate password change) — the error is the caller's to log.
 */
export async function checkNotBreached(input: {
  readonly plaintext: string;
  readonly policy: PasswordPolicy;
}): Promise<PasswordEvaluation> {
  const checker = input.policy.breachChecker;
  if (checker === null || checker === undefined) {
    return Object.freeze({ ok: true, violations: Object.freeze([]) });
  }
  const breached = await checker.isBreached(input.plaintext);
  return breached
    ? Object.freeze({ ok: false, violations: Object.freeze(["appears in a known data breach"]) })
    : Object.freeze({ ok: true, violations: Object.freeze([]) });
}
