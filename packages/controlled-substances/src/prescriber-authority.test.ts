// Prescriber DEA authority tests.
//
// This is the logic that decides whether a controlled prescription may
// be written, so the cases below are organized around the four ways it
// can refuse rather than around the code paths that produce them.
//
// The gate it replaces asked one question — "is a non-blank string
// present" — and therefore could not distinguish a lapsed registration
// from a revoked one from a live one that does not cover Schedule II.

import { describe, expect, it } from "vitest";

import { ControlledSubstanceSchedule, CredentialStatus } from "@pharmax/database";

import {
  DEA_AUTHORITY_EXPIRED,
  DEA_AUTHORITY_NO_REGISTRATION,
  DEA_AUTHORITY_NOT_ACTIVE,
  DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED,
  evaluatePrescriberDeaAuthority,
  type PrescriberDeaRegistrationFacts,
} from "./prescriber-authority.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const ALL_CONTROLLED = [
  ControlledSubstanceSchedule.CII,
  ControlledSubstanceSchedule.CIII,
  ControlledSubstanceSchedule.CIV,
  ControlledSubstanceSchedule.CV,
];

function registration(
  overrides: Partial<PrescriberDeaRegistrationFacts> = {}
): PrescriberDeaRegistrationFacts {
  return {
    deaNumber: "AB1234563",
    status: CredentialStatus.ACTIVE,
    expiresAt: null,
    authorizedSchedules: ALL_CONTROLLED,
    ...overrides,
  };
}

describe("evaluatePrescriberDeaAuthority — non-controlled", () => {
  it("passes with no registration at all", () => {
    // Requiring a DEA registration to write an ordinary prescription
    // would block most of the catalog.
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.NON_CONTROLLED,
      registrations: [],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("evaluatePrescriberDeaAuthority — grants", () => {
  it("grants when a live registration covers the schedule", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [registration()],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.deaNumber).toBe("AB1234563");
  });

  it("grants when the expiry is in the future", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CIV,
      registrations: [registration({ expiresAt: new Date("2027-01-01T00:00:00.000Z") })],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
  });

  it("grants when the expiry is not recorded", () => {
    // Null means nobody entered a date, which is a gap to close rather
    // than a lapse to enforce. Blocking here would take every migrating
    // tenant's controlled prescribing offline on day one.
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [registration({ expiresAt: null })],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
  });

  it("grants on the expiry date itself", () => {
    // A registration is valid through its expiry date, not up to the
    // day before. An off-by-one here refuses a lawful prescription.
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [registration({ expiresAt: NOW })],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
  });

  it("grants when any one of several registrations covers the schedule", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [
        registration({
          deaNumber: "MB1234563",
          authorizedSchedules: [ControlledSubstanceSchedule.CV],
        }),
        registration({ deaNumber: "AB1234563" }),
      ],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.deaNumber).toBe("AB1234563");
  });

  it("ignores a revoked registration in favour of a live one", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [
        registration({ deaNumber: "AB1234563", status: CredentialStatus.REVOKED }),
        registration({ deaNumber: "BB1234561" }),
      ],
      asOf: NOW,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.deaNumber).toBe("BB1234561");
  });
});

describe("evaluatePrescriberDeaAuthority — refusals", () => {
  it("reports NO_REGISTRATION when the prescriber holds none", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [],
      asOf: NOW,
    });
    expect(verdict).toEqual({
      ok: false,
      code: DEA_AUTHORITY_NO_REGISTRATION,
      registrationCount: 0,
    });
  });

  it("reports EXPIRED when the only registration has lapsed", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [registration({ expiresAt: new Date("2026-08-19T23:59:59.000Z") })],
      asOf: NOW,
    });
    expect(verdict).toMatchObject({ ok: false, code: DEA_AUTHORITY_EXPIRED });
  });

  it.each([CredentialStatus.REVOKED, CredentialStatus.SUSPENDED])(
    "reports NOT_ACTIVE when the only registration is %s",
    (status) => {
      const verdict = evaluatePrescriberDeaAuthority({
        schedule: ControlledSubstanceSchedule.CII,
        registrations: [registration({ status })],
        asOf: NOW,
      });
      expect(verdict).toMatchObject({ ok: false, code: DEA_AUTHORITY_NOT_ACTIVE });
    }
  );

  it("reports SCHEDULE_NOT_AUTHORIZED when a live registration does not cover it", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [
        registration({
          authorizedSchedules: [
            ControlledSubstanceSchedule.CIII,
            ControlledSubstanceSchedule.CIV,
            ControlledSubstanceSchedule.CV,
          ],
        }),
      ],
      asOf: NOW,
    });
    expect(verdict).toMatchObject({
      ok: false,
      code: DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED,
    });
  });

  it("prefers the most actionable reason when several apply", () => {
    // One live registration that does not cover CII, and one expired
    // one that would have. "Your registration doesn't cover CII" is
    // the fact the operator can act on; "something expired" would send
    // them chasing a renewal that changes nothing.
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [
        registration({ authorizedSchedules: [ControlledSubstanceSchedule.CV] }),
        registration({
          deaNumber: "BB1234561",
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        }),
      ],
      asOf: NOW,
    });
    expect(verdict).toMatchObject({
      ok: false,
      code: DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED,
      registrationCount: 2,
    });
  });

  it("never leaks the DEA number in a refusal", () => {
    const verdict = evaluatePrescriberDeaAuthority({
      schedule: ControlledSubstanceSchedule.CII,
      registrations: [registration({ status: CredentialStatus.REVOKED })],
      asOf: NOW,
    });
    // The refusal flows into an error payload; a prescribing credential
    // has no business there.
    expect(JSON.stringify(verdict)).not.toContain("AB1234563");
  });
});
