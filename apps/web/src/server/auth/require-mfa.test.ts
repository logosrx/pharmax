import { describe, expect, it } from "vitest";

import { enforceOperatorMfa, evaluateOperatorMfa, MfaRequiredError } from "./require-mfa";

/**
 * The write-time MFA gate had no tests until 2026-08-20, which is the
 * reason a defect in it survived: `SignIn` stamped `mfaSatisfied: true`
 * on every session, so `evaluateOperatorMfa` could never reach its deny
 * branch, and nothing asserted that it should be able to.
 *
 * The gate logic was always correct. It was simply unreachable. These
 * tests pin the reachability, not just the logic — the third case is the
 * one that was impossible before the sign-in fix.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("evaluateOperatorMfa", () => {
  it("does not require MFA for a principal holding no floor role", () => {
    // A technician is not on the floor. Their session legitimately
    // carries mfaSatisfied: false, and that must not deny them — this is
    // why recording the flag truthfully is safe.
    expect(evaluateOperatorMfa({ roleCodes: ["PharmacyTechnician"], mfaSatisfied: false })).toEqual(
      { status: "mfa_not_required" }
    );
  });

  it("passes a floor-role holder whose session cleared MFA", () => {
    expect(evaluateOperatorMfa({ roleCodes: ["Pharmacist"], mfaSatisfied: true })).toEqual({
      status: "mfa_satisfied",
    });
  });

  it("DENIES a floor-role holder whose session did not clear MFA", () => {
    // The case that could not occur before 2026-08-20. It is reachable
    // now, and it is the whole point of the control: a session minted
    // before the role was granted carries no second factor and must not
    // be waved through on the strength of the role alone.
    const outcome = evaluateOperatorMfa({ roleCodes: ["Pharmacist"], mfaSatisfied: false });

    expect(outcome.status).toBe("mfa_required_not_satisfied");
    expect(outcome).toMatchObject({ enforcingRoleCodes: ["Pharmacist"] });
  });

  it("names every enforcing role, not just the first", () => {
    const outcome = evaluateOperatorMfa({
      roleCodes: ["PharmacyTechnician", "Pharmacist", "BillingManager"],
      mfaSatisfied: false,
    });

    expect(outcome).toMatchObject({
      enforcingRoleCodes: ["Pharmacist", "BillingManager"],
    });
  });

  it("treats an empty role set as not requiring MFA", () => {
    expect(evaluateOperatorMfa({ roleCodes: [], mfaSatisfied: false })).toEqual({
      status: "mfa_not_required",
    });
  });
});

describe("enforceOperatorMfa", () => {
  it("throws MFA_REQUIRED for a floor role on an unsatisfied session", () => {
    expect(() =>
      enforceOperatorMfa({ userId: USER_ID, roleCodes: ["OrgAdmin"], mfaSatisfied: false })
    ).toThrow(MfaRequiredError);
  });

  it("carries the enforcing roles on the error, so the operator learns why", () => {
    try {
      enforceOperatorMfa({ userId: USER_ID, roleCodes: ["SecurityOfficer"], mfaSatisfied: false });
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MfaRequiredError);
      expect((cause as MfaRequiredError).enforcingRoleCodes).toEqual(["SecurityOfficer"]);
    }
  });

  it("returns silently when MFA is not required", () => {
    expect(() =>
      enforceOperatorMfa({
        userId: USER_ID,
        roleCodes: ["PharmacyTechnician"],
        mfaSatisfied: false,
      })
    ).not.toThrow();
  });

  it("returns silently when the session cleared MFA", () => {
    expect(() =>
      enforceOperatorMfa({ userId: USER_ID, roleCodes: ["OrgAdmin"], mfaSatisfied: true })
    ).not.toThrow();
  });

  it.each([
    "OrgAdmin",
    "Pharmacist",
    "BillingManager",
    "SecurityOfficer",
    "ComplianceOfficer",
    "PharmacistInCharge",
  ])("enforces the floor for %s", (role) => {
    // Pins the floor to all six elevated roles. Two signed documents
    // still describe it as OrgAdmin and BillingManager only; the code
    // has been broader since #201, and this asserts which is true.
    expect(() =>
      enforceOperatorMfa({ userId: USER_ID, roleCodes: [role], mfaSatisfied: false })
    ).toThrow(MfaRequiredError);
  });
});
