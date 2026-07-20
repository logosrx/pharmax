import { clock } from "@pharmax/platform-core";
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

  it("MFA floor covers the privileged roles from ADR-0025", () => {
    expect(MFA_REQUIRED_ROLE_CODES.has("OrgAdmin")).toBe(true);
    expect(MFA_REQUIRED_ROLE_CODES.has("BillingManager")).toBe(true);
    expect(MFA_REQUIRED_ROLE_CODES.has("Pharmacist")).toBe(false);
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
