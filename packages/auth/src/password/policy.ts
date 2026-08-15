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
// plaintext strength. `evaluatePasswordPolicy` is called from inside the
// command transaction (it is pure and synchronous); `checkNotBreached`
// reaches a third-party corpus and is therefore called from the
// PRE-TRANSACTION screen in breach-screen.ts, never with a database
// transaction open.

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
  /**
   * Wall-clock budget for ONE `breachChecker.isBreached` call.
   * Exceeding it is a BYPASS, not a rejection — see `checkNotBreached`.
   */
  readonly breachCheckTimeoutMs: number;
}

/**
 * Budget for a single breach-corpus lookup: 2 seconds.
 *
 * The ceiling is set by what a person will wait on an interactive
 * credential-setting request, not by what a degraded provider might
 * eventually manage. A k-anonymity range query is one small HTTPS GET
 * against a CDN-fronted corpus and answers in tens of milliseconds
 * when healthy, so 2s leaves roughly an order of magnitude of
 * headroom: long enough that an ordinary latency spike still yields a
 * real verdict, short enough that a wedged provider costs a user two
 * seconds instead of their whole request. Raise it per deployment via
 * `PasswordPolicy.breachCheckTimeoutMs` if a slower self-hosted
 * corpus needs more room.
 */
export const DEFAULT_BREACH_CHECK_TIMEOUT_MS = 2_000;

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
  breachCheckTimeoutMs: DEFAULT_BREACH_CHECK_TIMEOUT_MS,
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

/** How a breach screen arrived at its verdict. */
export type BreachScreenOutcome =
  /** The checker answered within its budget; the verdict is real. */
  | "checked"
  /** No checker is wired for this deployment; nothing was screened. */
  | "not_configured"
  /** The checker threw. Failed open — treated as not breached. */
  | "bypassed_error"
  /** The checker exceeded its budget. Failed open — treated as not breached. */
  | "bypassed_timeout";

export interface BreachScreenResult extends PasswordEvaluation {
  readonly outcome: BreachScreenOutcome;
}

/** Marker for a checker that blew its budget. Never surfaces to a caller. */
class BreachCheckTimeout extends Error {
  constructor() {
    super("breach check exceeded its budget");
    this.name = "BreachCheckTimeout";
  }
}

function notBreached(outcome: BreachScreenOutcome): BreachScreenResult {
  return Object.freeze({ ok: true, violations: Object.freeze([]), outcome });
}

/**
 * Runs the configured breach check (if any) under a wall-clock budget.
 * Returns a violation list so the caller can merge it with the
 * structural evaluation, plus the `outcome` that produced it.
 *
 * FAILS OPEN on checker error OR timeout: a breach-corpus outage must
 * not block a legitimate password change, and an operator locked out
 * of rotating a compromised credential is the worse failure. The cost
 * is that the control silently stops existing during the outage, so
 * the bypass is NOT swallowed — `outcome` names it, and callers carry
 * it into audit metadata and a warning log (see breach-screen.ts).
 *
 * A timed-out check is abandoned, not cancelled: `BreachChecker` takes
 * no abort signal, so the underlying request may still be in flight
 * when this returns. That is survivable ONLY because this runs before
 * the command's transaction opens — a stalled call holds no database
 * connection and no row locks.
 */
export async function checkNotBreached(input: {
  readonly plaintext: string;
  readonly policy: PasswordPolicy;
}): Promise<BreachScreenResult> {
  const checker = input.policy.breachChecker;
  if (checker === null || checker === undefined) {
    return notBreached("not_configured");
  }

  let breached: boolean;
  try {
    breached = await withTimeout(
      checker.isBreached(input.plaintext),
      input.policy.breachCheckTimeoutMs
    );
  } catch (cause) {
    return notBreached(cause instanceof BreachCheckTimeout ? "bypassed_timeout" : "bypassed_error");
  }

  return breached
    ? Object.freeze({
        ok: false,
        violations: Object.freeze(["appears in a known data breach"]),
        outcome: "checked",
      })
    : notBreached("checked");
}

/**
 * Resolve `work`, or reject with `BreachCheckTimeout` after
 * `timeoutMs`. `Promise.race` subscribes to `work`, so a later
 * rejection from an abandoned call is already handled and cannot
 * become an unhandled rejection.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    // Deliberately NOT unref'd: for a checker that hangs without a
    // ref'd handle of its own, this timer is the only thing that can
    // settle the race, and an unref'd one would let the process exit
    // mid-request instead of failing open. The `finally` below clears
    // it as soon as the check answers, so a healthy call does not pay
    // the budget in wall-clock time.
    timer = setTimeout(() => reject(new BreachCheckTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
}
