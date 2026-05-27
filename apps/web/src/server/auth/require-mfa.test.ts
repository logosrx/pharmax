// Contract tests for the MFA gate.
//
// All Clerk lookups are injected via `options.getClerkUserMfa` so
// the suite runs offline with no Clerk SDK. Tests that need to
// exercise the cached production getter would pull in the React
// cache + Clerk Backend SDK, which is over-scope for unit tests;
// those paths are covered by the integration suite.
//
// Test data convention: synthetic identifiers only — no real
// patient or operator data, per .cursor/rules/02-security-compliance.

import { errors } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  MFA_REQUIRED,
  MFA_LOOKUP_FAILED,
  MFA_REQUIRED_ROLE_CODES,
  MfaLookupFailedError,
  MfaRequiredError,
  countMfaFactors,
  enforceMfaForCommand,
  requireOperatorMfa,
  type ClerkUserMfaSnapshot,
} from "./require-mfa.js";

const CLERK_USER_ID = "clerk_user_2gateTEST";

function snapshot(overrides: Partial<ClerkUserMfaSnapshot> = {}): ClerkUserMfaSnapshot {
  return Object.freeze({
    twoFactorEnabled: false,
    totpEnabled: false,
    backupCodeEnabled: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Floor invariants
// ---------------------------------------------------------------------------

describe("MFA_REQUIRED_ROLE_CODES", () => {
  it("locks in OrgAdmin and BillingManager as the platform floor", () => {
    expect(MFA_REQUIRED_ROLE_CODES.has("OrgAdmin")).toBe(true);
    expect(MFA_REQUIRED_ROLE_CODES.has("BillingManager")).toBe(true);
    // Sanity: non-privileged roles are NOT in the set. If a future
    // change adds them, that's a policy decision worth surfacing in
    // a failing test.
    expect(MFA_REQUIRED_ROLE_CODES.has("Pharmacist")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("PharmacyTechnician")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("ShippingClerk")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("ClinicViewer")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("WebhookService")).toBe(false);
  });

  it("is case-sensitive — lowercase lookalikes do not match", () => {
    // The set check is case-sensitive by construction. A lowercase
    // role code in user input would slip past the floor if we ever
    // started normalizing here. Lock that down.
    expect(MFA_REQUIRED_ROLE_CODES.has("orgadmin")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("ORGADMIN")).toBe(false);
    expect(MFA_REQUIRED_ROLE_CODES.has("billingmanager")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countMfaFactors
// ---------------------------------------------------------------------------

describe("countMfaFactors", () => {
  it("returns 0 for a fully un-enrolled snapshot", () => {
    expect(countMfaFactors(snapshot())).toBe(0);
  });
  it("counts TOTP + backup codes independently", () => {
    expect(
      countMfaFactors(
        snapshot({ totpEnabled: true, backupCodeEnabled: true, twoFactorEnabled: true })
      )
    ).toBe(2);
  });
  it("falls back to 1 when the roll-up is true but no specific factor flag is", () => {
    expect(countMfaFactors(snapshot({ twoFactorEnabled: true }))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// requireOperatorMfa — every outcome path
// ---------------------------------------------------------------------------

describe("requireOperatorMfa", () => {
  it("returns mfa_not_required when no enforcing role is present and does NOT call Clerk", async () => {
    const getClerkUserMfa = vi.fn();
    const result = await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["Pharmacist", "ShippingClerk"],
      options: { getClerkUserMfa },
    });
    expect(result.status).toBe("mfa_not_required");
    expect(getClerkUserMfa).not.toHaveBeenCalled();
  });

  it("returns mfa_satisfied when an OrgAdmin has TOTP enrolled", async () => {
    const result = await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["OrgAdmin"],
      options: {
        getClerkUserMfa: async () => snapshot({ totpEnabled: true, twoFactorEnabled: true }),
      },
    });
    expect(result.status).toBe("mfa_satisfied");
    if (result.status === "mfa_satisfied") {
      expect(result.factorCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns mfa_required_not_enrolled when a BillingManager has zero factors", async () => {
    const result = await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["BillingManager", "ClinicViewer"],
      options: {
        getClerkUserMfa: async () => snapshot(),
      },
    });
    expect(result.status).toBe("mfa_required_not_enrolled");
    if (result.status === "mfa_required_not_enrolled") {
      expect(result.enforcingRoleCodes).toEqual(["BillingManager"]);
    }
  });

  it("returns mfa_lookup_failed on Clerk SDK error and includes the enforcing roles", async () => {
    const result = await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["OrgAdmin"],
      options: {
        getClerkUserMfa: async () => {
          throw new Error("clerk_api_unreachable");
        },
      },
    });
    expect(result.status).toBe("mfa_lookup_failed");
    if (result.status === "mfa_lookup_failed") {
      expect(result.enforcingRoleCodes).toEqual(["OrgAdmin"]);
      expect(result.error).toBe("clerk_api_unreachable");
    }
  });

  it("multi-role: only one enforcing role triggers the floor (the rest pass through)", async () => {
    const getClerkUserMfa = vi.fn(async () =>
      snapshot({ totpEnabled: true, twoFactorEnabled: true })
    );
    // Pharmacist + ClinicViewer are not on the floor; OrgAdmin is.
    // Only one Clerk lookup should be issued.
    const result = await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["Pharmacist", "OrgAdmin", "ClinicViewer"],
      options: { getClerkUserMfa },
    });
    expect(result.status).toBe("mfa_satisfied");
    expect(getClerkUserMfa).toHaveBeenCalledTimes(1);
  });

  it("multi-role enforcing: a single getter call regardless of how many enforcing roles", async () => {
    const getClerkUserMfa = vi.fn(async () =>
      snapshot({ totpEnabled: true, twoFactorEnabled: true })
    );
    await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["OrgAdmin", "BillingManager"],
      options: { getClerkUserMfa },
    });
    expect(getClerkUserMfa).toHaveBeenCalledTimes(1);
  });

  it("ignores roles whose case does not match the canonical floor codes", async () => {
    // Lowercased role code from the RBAC loader (a hypothetical bug
    // upstream) MUST NOT trigger the floor — we'd silently let an
    // operator pass if it did.
    const getClerkUserMfa = vi.fn();
    const result = await requireOperatorMfa({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["orgadmin", "billingmanager"],
      options: { getClerkUserMfa },
    });
    expect(result.status).toBe("mfa_not_required");
    expect(getClerkUserMfa).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// enforceMfaForCommand — throw shapes
// ---------------------------------------------------------------------------

describe("enforceMfaForCommand", () => {
  it("does not throw when MFA is satisfied", async () => {
    await expect(
      enforceMfaForCommand({
        clerkUserId: CLERK_USER_ID,
        roleCodes: ["OrgAdmin"],
        options: {
          getClerkUserMfa: async () => snapshot({ totpEnabled: true, twoFactorEnabled: true }),
        },
      })
    ).resolves.toBeUndefined();
  });

  it("does not throw when no enforcing role is present", async () => {
    await expect(
      enforceMfaForCommand({
        clerkUserId: CLERK_USER_ID,
        roleCodes: ["Pharmacist"],
      })
    ).resolves.toBeUndefined();
  });

  it("throws MfaRequiredError with code MFA_REQUIRED on missing factor", async () => {
    const promise = enforceMfaForCommand({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["OrgAdmin"],
      options: { getClerkUserMfa: async () => snapshot() },
    });
    await expect(promise).rejects.toBeInstanceOf(MfaRequiredError);
    await expect(promise).rejects.toMatchObject({
      code: MFA_REQUIRED,
      httpStatus: 403,
    });
    await expect(promise).rejects.toBeInstanceOf(errors.AuthorizationError);
    try {
      await promise;
    } catch (cause) {
      if (cause instanceof MfaRequiredError) {
        expect(cause.enforcingRoleCodes).toEqual(["OrgAdmin"]);
        expect(cause.metadata).toMatchObject({
          clerkUserId: CLERK_USER_ID,
          enforcingRoleCodes: ["OrgAdmin"],
        });
      }
    }
  });

  it("throws MfaLookupFailedError with code MFA_LOOKUP_FAILED on Clerk outage", async () => {
    const promise = enforceMfaForCommand({
      clerkUserId: CLERK_USER_ID,
      roleCodes: ["BillingManager"],
      options: {
        getClerkUserMfa: async () => {
          throw new Error("clerk_unreachable");
        },
      },
    });
    await expect(promise).rejects.toBeInstanceOf(MfaLookupFailedError);
    await expect(promise).rejects.toMatchObject({
      code: MFA_LOOKUP_FAILED,
      httpStatus: 403,
    });
    try {
      await promise;
    } catch (cause) {
      if (cause instanceof MfaLookupFailedError) {
        expect(cause.enforcingRoleCodes).toEqual(["BillingManager"]);
        expect((cause.metadata as Record<string, unknown>).cause).toBe("clerk_unreachable");
      }
    }
  });
});
