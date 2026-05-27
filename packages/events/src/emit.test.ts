// emit() helper tests.
//
// Covers:
//   - Typed path validates payload + composes draft with definition
//     metadata.
//   - Typed path throws ValidationError on schema mismatch.
//   - Legacy path with a registered name validates against the
//     registry.
//   - Legacy path with an unregistered name passes through and uses
//     caller-supplied aggregateType/Id.

import { errors } from "@pharmax/platform-core";
import { describe, expect, it } from "vitest";

import { emit, EVENT_PAYLOAD_INVALID } from "./emit.js";
import { PatientRegisteredV1 } from "./events/patient/registered-v1.js";

const SAMPLE_PATIENT_PAYLOAD = Object.freeze({
  patientId: "00000000-0000-4000-8000-000000000000",
  organizationId: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("emit — typed path", () => {
  it("returns an outbox draft with definition-derived metadata", () => {
    const draft = emit(PatientRegisteredV1, { ...SAMPLE_PATIENT_PAYLOAD });
    expect(draft.eventType).toBe("patient.registered.v1");
    expect(draft.aggregateType).toBe("Patient");
    expect(draft.aggregateId).toBe(SAMPLE_PATIENT_PAYLOAD.patientId);
    expect(draft.payload).toMatchObject(SAMPLE_PATIENT_PAYLOAD);
  });

  it("freezes the returned draft", () => {
    const draft = emit(PatientRegisteredV1, { ...SAMPLE_PATIENT_PAYLOAD });
    expect(Object.isFrozen(draft)).toBe(true);
  });

  it("throws ValidationError when the payload fails schema validation", () => {
    expect(() =>
      emit(PatientRegisteredV1, {
        ...SAMPLE_PATIENT_PAYLOAD,
        patientId: "not-a-uuid",
      })
    ).toThrow(errors.ValidationError);
  });

  it("tags the validation error with EVENT_PAYLOAD_INVALID", () => {
    try {
      emit(PatientRegisteredV1, {
        ...SAMPLE_PATIENT_PAYLOAD,
        patientId: "not-a-uuid",
      });
      expect.fail("emit should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(errors.ValidationError);
      const pharmaxErr = err as errors.ValidationError;
      expect(pharmaxErr.code).toBe(EVENT_PAYLOAD_INVALID);
    }
  });
});

describe("emit — legacy path", () => {
  it("validates against the registry when the name is registered", () => {
    const draft = emit(
      "patient.registered.v1",
      { ...SAMPLE_PATIENT_PAYLOAD },
      { aggregateType: "Patient", aggregateId: SAMPLE_PATIENT_PAYLOAD.patientId }
    );
    expect(draft.eventType).toBe("patient.registered.v1");
    expect(draft.payload).toMatchObject(SAMPLE_PATIENT_PAYLOAD);
  });

  it("throws ValidationError when a registered legacy payload is malformed", () => {
    expect(() =>
      emit(
        "patient.registered.v1",
        { patientId: "x" },
        { aggregateType: "Patient", aggregateId: "x" }
      )
    ).toThrow(errors.ValidationError);
  });

  it("passes through unregistered event names without validation", () => {
    const draft = emit(
      "some.unregistered.event.v1",
      { foo: "bar" },
      { aggregateType: "Order", aggregateId: "abc" }
    );
    expect(draft.eventType).toBe("some.unregistered.event.v1");
    expect(draft.payload).toEqual({ foo: "bar" });
    expect(draft.aggregateType).toBe("Order");
    expect(draft.aggregateId).toBe("abc");
  });

  it("throws if legacy options are missing", () => {
    // @ts-expect-error — exercising the runtime guard.
    expect(() => emit("foo.bar.v1", { x: 1 })).toThrow();
  });
});
