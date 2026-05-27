// Schema tests for patient.viewed.v1 — the HIPAA-required access-log event.
//
// PHI sanity check: this schema MUST refuse to accept fields with
// PHI-shaped names (firstName, dateOfBirth, ssnLast4, etc.). The
// strict() mode handles that — these tests pin the behavior so a
// future schema relaxation can't silently leak PHI through the
// payload.

import { describe, expect, it } from "vitest";

import { validateAgainst } from "../../define-event.js";
import { PatientViewedV1 } from "./viewed-v1.js";

const HAPPY: Record<string, unknown> = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  patientId: "00000000-0000-4000-8000-000000000002",
  surface: "ORDER_DETAIL_PAGE",
  orderId: "00000000-0000-4000-8000-000000000003",
  actorUserId: "00000000-0000-4000-8000-000000000004",
  phiDecryptErrors: 0,
  wasShredded: false,
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("PatientViewedV1 schema", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAgainst(PatientViewedV1, HAPPY).ok).toBe(true);
  });

  it("accepts a payload without optional orderId", () => {
    const noOrder: Record<string, unknown> = { ...HAPPY };
    delete noOrder["orderId"];
    expect(validateAgainst(PatientViewedV1, noOrder).ok).toBe(true);
  });

  it("rejects an unknown surface code", () => {
    expect(
      validateAgainst(PatientViewedV1, { ...HAPPY, surface: "NEW_UNTRACKED_SURFACE" }).ok
    ).toBe(false);
  });

  it("rejects PHI-shaped extras (firstName)", () => {
    expect(validateAgainst(PatientViewedV1, { ...HAPPY, firstName: "Sample" }).ok).toBe(false);
  });

  it("rejects PHI-shaped extras (dateOfBirth)", () => {
    expect(validateAgainst(PatientViewedV1, { ...HAPPY, dateOfBirth: "1990-01-01" }).ok).toBe(
      false
    );
  });

  it("rejects PHI-shaped extras (ssnLast4)", () => {
    expect(validateAgainst(PatientViewedV1, { ...HAPPY, ssnLast4: "1234" }).ok).toBe(false);
  });

  it("rejects negative phiDecryptErrors", () => {
    expect(validateAgainst(PatientViewedV1, { ...HAPPY, phiDecryptErrors: -1 }).ok).toBe(false);
  });

  it("aggregateIdFrom selects patientId", () => {
    expect(PatientViewedV1.aggregateIdFrom(HAPPY as never)).toBe(HAPPY.patientId);
  });
});
