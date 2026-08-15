import { describe, expect, it } from "vitest";

import {
  checkNotBreached,
  DEFAULT_PASSWORD_POLICY,
  evaluatePasswordPolicy,
  type BreachChecker,
  type PasswordPolicy,
} from "./policy.js";

describe("evaluatePasswordPolicy — length", () => {
  it("rejects a password shorter than minLength", () => {
    const result = evaluatePasswordPolicy({ plaintext: "short", policy: DEFAULT_PASSWORD_POLICY });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("at least 12");
  });

  it("rejects a password longer than maxLength", () => {
    const result = evaluatePasswordPolicy({
      plaintext: "a".repeat(DEFAULT_PASSWORD_POLICY.maxLength + 1),
      policy: DEFAULT_PASSWORD_POLICY,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("at most");
  });

  it("accepts a sufficiently long password (NIST default: length only)", () => {
    const result = evaluatePasswordPolicy({
      plaintext: "correct horse battery staple",
      policy: DEFAULT_PASSWORD_POLICY,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("evaluatePasswordPolicy — composition (opt-in)", () => {
  const composed: PasswordPolicy = {
    ...DEFAULT_PASSWORD_POLICY,
    requireCharacterClasses: true,
    minCharacterClasses: 3,
  };

  it("rejects when fewer than the required character classes are present", () => {
    const result = evaluatePasswordPolicy({ plaintext: "alllowercaseletters", policy: composed });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("lowercase, uppercase, digit, symbol");
  });

  it("accepts when enough classes are present", () => {
    const result = evaluatePasswordPolicy({ plaintext: "Abcdefgh1234!", policy: composed });
    expect(result.ok).toBe(true);
  });
});

describe("evaluatePasswordPolicy — context reuse", () => {
  it("rejects a password containing the email local-part or name", () => {
    const result = evaluatePasswordPolicy({
      plaintext: "alexander-the-great-1",
      policy: DEFAULT_PASSWORD_POLICY,
      disallowedSubstrings: ["alexander", "Alex Tech"],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("name or email");
  });

  it("ignores disallowed substrings shorter than 3 chars", () => {
    const result = evaluatePasswordPolicy({
      plaintext: "a-perfectly-fine-passphrase",
      policy: DEFAULT_PASSWORD_POLICY,
      disallowedSubstrings: ["a", "x"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("checkNotBreached", () => {
  it("is a no-op (ok) when no breach checker is configured", async () => {
    const result = await checkNotBreached({
      plaintext: "anything at all here",
      policy: DEFAULT_PASSWORD_POLICY,
    });
    expect(result.ok).toBe(true);
    // Distinguishable from a real pass: nothing was screened.
    expect(result.outcome).toBe("not_configured");
  });

  it("flags a breached password", async () => {
    const checker: BreachChecker = { isBreached: async () => true };
    const result = await checkNotBreached({
      plaintext: "password123456",
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("data breach");
    expect(result.outcome).toBe("checked");
  });

  it("passes a non-breached password", async () => {
    const checker: BreachChecker = { isBreached: async () => false };
    const result = await checkNotBreached({
      plaintext: "a-unique-strong-passphrase",
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("checked");
  });
});

describe("checkNotBreached — degraded checker", () => {
  const PLAINTEXT = "a-unique-strong-passphrase";

  it("fails OPEN when the checker throws", async () => {
    const checker: BreachChecker = {
      isBreached: () => Promise.reject(new Error("corpus 503")),
    };
    const result = await checkNotBreached({
      plaintext: PLAINTEXT,
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });

    // The module documents fail-open and now implements it: an outage in
    // a third-party corpus must not block an operator from rotating a
    // credential they believe is compromised.
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.outcome).toBe("bypassed_error");
  });

  it("fails OPEN when the checker throws a non-Error value", async () => {
    const checker: BreachChecker = {
      isBreached: () => Promise.reject("string rejection"),
    };
    const result = await checkNotBreached({
      plaintext: PLAINTEXT,
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("bypassed_error");
  });

  it("gives up at the timeout instead of waiting on a hung checker", async () => {
    // Never settles. Before the budget existed this promise WAS the
    // request: the command's transaction stayed open behind it.
    const checker: BreachChecker = { isBreached: () => new Promise<boolean>(() => undefined) };
    const startedAt = Date.now();
    const result = await checkNotBreached({
      plaintext: PLAINTEXT,
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker, breachCheckTimeoutMs: 20 },
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("bypassed_timeout");
    // Bounded by the budget. Loose upper bound so a busy CI runner
    // cannot flake it; a lost timeout hangs until vitest's cap instead.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("still returns a real verdict for a checker that is slow but inside its budget", async () => {
    const checker: BreachChecker = {
      isBreached: () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), 5);
        }),
    };
    const result = await checkNotBreached({
      plaintext: PLAINTEXT,
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker, breachCheckTimeoutMs: 5_000 },
    });

    // Pins the direction of the race: the budget must not pre-empt a
    // checker that answers in time.
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("checked");
  });

  it("never echoes the plaintext in what it returns", async () => {
    const checker: BreachChecker = {
      isBreached: () => Promise.reject(new Error(`failed while checking ${PLAINTEXT}`)),
    };
    const result = await checkNotBreached({
      plaintext: PLAINTEXT,
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });

    // A careless checker may put the password in its error message; the
    // screen result is carried into audit metadata, so it must not
    // forward any of it.
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
  });
});
