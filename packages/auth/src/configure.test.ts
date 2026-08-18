import { clock } from "@pharmax/platform-core";
import { ELEVATED_ROLE_CODES } from "@pharmax/rbac";
import { afterEach, describe, expect, it } from "vitest";

import { AUTH_NOT_CONFIGURED, authNotConfiguredError } from "./errors.js";
import {
  buildAuthConfiguration,
  configureAuth,
  DEFAULT_LOCKOUT_POLICY,
  DEFAULT_MFA_POLICY,
  DEFAULT_SESSION_POLICY,
  getAuthConfiguration,
  MFA_REQUIRED_ROLE_CODES,
  resetAuthConfigurationForTests,
} from "./configure.js";
import type { PasswordHasher } from "./password/hasher.js";

const fakeHasher: PasswordHasher = {
  async hash(p) {
    return `h:${p}`;
  },
  async verify(h, p) {
    return h === `h:${p}`;
  },
  needsRehash() {
    return false;
  },
};

afterEach(() => resetAuthConfigurationForTests());

describe("configureAuth / getAuthConfiguration", () => {
  it("throws AUTH_NOT_CONFIGURED before configuration", () => {
    resetAuthConfigurationForTests();
    expect(() => getAuthConfiguration()).toThrowError();
    expect(authNotConfiguredError().code).toBe(AUTH_NOT_CONFIGURED);
  });

  it("returns the wired configuration after configureAuth", () => {
    const config = buildAuthConfiguration({ clock: clock.systemClock, hasher: fakeHasher });
    configureAuth(config);
    const got = getAuthConfiguration();
    expect(got.hasher).toBe(fakeHasher);
    expect(got.session).toEqual(DEFAULT_SESSION_POLICY);
    expect(got.mfa).toEqual(DEFAULT_MFA_POLICY);
    expect(got.lockout).toEqual(DEFAULT_LOCKOUT_POLICY);
  });
});

describe("policy defaults", () => {
  it("session policy is HIPAA-conscious (30m idle, 12h absolute)", () => {
    expect(DEFAULT_SESSION_POLICY.idleTtlMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_SESSION_POLICY.absoluteTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(DEFAULT_SESSION_POLICY.tokenBytes).toBeGreaterThanOrEqual(32);
  });

  it("MFA floor covers every elevated role", () => {
    for (const code of ELEVATED_ROLE_CODES) {
      expect(MFA_REQUIRED_ROLE_CODES.has(code), `${code} must require MFA`).toBe(true);
    }
  });

  // The floor was `{OrgAdmin, BillingManager}` and this test used to
  // assert `Pharmacist` was EXCLUDED — the gap was pinned rather than
  // caught. Pharmacists hold the broadest PHI access in the product,
  // so a password-only pharmacist was the largest identity gap in the
  // system. Named explicitly so re-narrowing the floor has to delete a
  // test that says why.
  it("requires MFA for pharmacists, who hold the broadest PHI access", () => {
    expect(MFA_REQUIRED_ROLE_CODES.has("Pharmacist")).toBe(true);
    expect(MFA_REQUIRED_ROLE_CODES.has("PharmacistInCharge")).toBe(true);
  });

  // The engine and the compliance probes evaluate the same question —
  // "is this principal elevated?" — and used to hold different answers,
  // so a probe reported an MFA gap the engine had no intention of
  // enforcing. One definition now, and this fails if that regresses.
  it("floor is exactly the platform's elevated-role set, with no drift", () => {
    expect([...MFA_REQUIRED_ROLE_CODES].sort()).toEqual([...ELEVATED_ROLE_CODES].sort());
  });

  it("does not require MFA for non-elevated operational roles", () => {
    expect(MFA_REQUIRED_ROLE_CODES.has("PharmacyTechnician")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("ShippingClerk")).toBe(false);
  });

  it("buildAuthConfiguration applies partial overrides over defaults", () => {
    const config = buildAuthConfiguration({
      clock: clock.systemClock,
      hasher: fakeHasher,
      session: { idleTtlMs: 60_000 },
      lockout: { maxFailures: 3 },
    });
    expect(config.session.idleTtlMs).toBe(60_000);
    expect(config.session.absoluteTtlMs).toBe(DEFAULT_SESSION_POLICY.absoluteTtlMs);
    expect(config.lockout.maxFailures).toBe(3);
  });
});
