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
  });

  it("flags a breached password", async () => {
    const checker: BreachChecker = { isBreached: async () => true };
    const result = await checkNotBreached({
      plaintext: "password123456",
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("data breach");
  });

  it("passes a non-breached password", async () => {
    const checker: BreachChecker = { isBreached: async () => false };
    const result = await checkNotBreached({
      plaintext: "a-unique-strong-passphrase",
      policy: { ...DEFAULT_PASSWORD_POLICY, breachChecker: checker },
    });
    expect(result.ok).toBe(true);
  });
});
