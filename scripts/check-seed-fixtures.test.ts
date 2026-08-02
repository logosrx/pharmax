// Unit tests for the demo-dataset completeness checker.
//
// Exercises the pure `evaluateSeedSnapshot` against synthetic snapshots.
// The cases mirror the 2026-08-02 finding that motivated the check: a
// seed can exit 0 while silently omitting the fixtures a merged feature
// needs, so each omission must be reported by name.

import { describe, expect, it } from "vitest";

import { evaluateSeedSnapshot, type SeedSnapshot } from "./check-seed-fixtures.js";

const ROLE_CODES = ["OrgAdmin", "ProviderOnboardingService", "ProviderPortalService"];

/** A snapshot with every expected fixture present. */
const COMPLETE: SeedSnapshot = {
  orgFound: true,
  providerOnboardingEnabled: true,
  roleCodes: ROLE_CODES,
  serviceIdentityGrants: {
    "provider-onboarding@acme.test": 1,
    "provider-portal@acme.test": 1,
    "print-agent@acme.test": 1,
  },
  activeWorkflowPolicyCodes: ["order.standard", "provider.onboarding"],
  workstationCodes: ["WS-01"],
};

const fixturesOf = (v: ReadonlyArray<{ fixture: string }>): string[] => v.map((x) => x.fixture);

describe("evaluateSeedSnapshot", () => {
  it("passes a complete demo dataset", () => {
    expect(evaluateSeedSnapshot(COMPLETE, ROLE_CODES)).toEqual([]);
  });

  it("reports the missing org once instead of cascading derived failures", () => {
    const violations = evaluateSeedSnapshot(
      {
        orgFound: false,
        providerOnboardingEnabled: false,
        roleCodes: [],
        serviceIdentityGrants: {},
        activeWorkflowPolicyCodes: [],
        workstationCodes: [],
      },
      ROLE_CODES
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.fixture).toContain("organization");
  });

  // The exact 2026-08-02 shape: the provider portal merged without its
  // seed wiring, so the org existed but opted out and none of the
  // onboarding fixtures were created.
  it("catches the provider-onboarding regression in full", () => {
    const violations = evaluateSeedSnapshot(
      {
        ...COMPLETE,
        providerOnboardingEnabled: false,
        serviceIdentityGrants: { "print-agent@acme.test": 1 },
        activeWorkflowPolicyCodes: ["order.standard"],
      },
      ROLE_CODES
    );

    expect(fixturesOf(violations)).toEqual(
      expect.arrayContaining([
        "organization.providerOnboardingEnabled",
        'service identity "provider-onboarding@acme.test"',
        'service identity "provider-portal@acme.test"',
        'workflow policy "provider.onboarding"',
      ])
    );
  });

  it("flags a role template that exists in rbac but was never seeded", () => {
    const violations = evaluateSeedSnapshot(COMPLETE, [...ROLE_CODES, "NewlyAddedTemplate"]);

    expect(fixturesOf(violations)).toEqual(['role "NewlyAddedTemplate"']);
  });

  // A user row with no grant is worse than a missing one: it
  // authenticates and then fails every permission check.
  it("distinguishes an ungranted service identity from a missing one", () => {
    const violations = evaluateSeedSnapshot(
      {
        ...COMPLETE,
        serviceIdentityGrants: {
          ...COMPLETE.serviceIdentityGrants,
          "provider-portal@acme.test": 0,
        },
      },
      ROLE_CODES
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("no role grant");
  });

  it("treats an inactive workflow policy as absent", () => {
    const violations = evaluateSeedSnapshot(
      { ...COMPLETE, activeWorkflowPolicyCodes: ["order.standard"] },
      ROLE_CODES
    );

    expect(fixturesOf(violations)).toEqual(['workflow policy "provider.onboarding"']);
  });

  it("flags the workstation apps/print-agent resolves at boot", () => {
    const violations = evaluateSeedSnapshot({ ...COMPLETE, workstationCodes: [] }, ROLE_CODES);

    expect(fixturesOf(violations)).toEqual(['workstation "WS-01"']);
  });
});
