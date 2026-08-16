// decryptPatientFields contract tests (coverage-audit 2026-08,
// backfill item 9).
//
// The behavior pinned here: PHI decryption NEVER throws out of this
// helper. A per-envelope failure (KMS down, envelope corruption, AAD
// mismatch) yields null for that ONE field and flips the
// `phiDecryptErrors` flag so the caller renders an incident banner —
// a partial record view instead of a 500, and never an unflagged
// partial render.
//
// Mocks `@pharmax/crypto` and the web logger, same as
// `get-order-detail.test.ts`. CLEAN ROOM / PHI: synthetic values only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000a1";

const decryptMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return noop;
});

vi.mock("@pharmax/crypto", () => ({ decryptField: decryptMock }));
vi.mock("../logger.js", () => ({ logger: loggerMock }));

import { decryptPatientFields } from "./decrypt-patient.js";

/** All 14 PHI columns the helper decrypts, in projection order. */
const ALL_COLUMNS = [
  "firstName",
  "lastName",
  "middleName",
  "dateOfBirth",
  "sexAtBirth",
  "ssnLast4",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "mrn",
] as const;

type Column = (typeof ALL_COLUMNS)[number];

function envelope(column: Column): { v: number; ct: string } {
  return { v: 1, ct: `ct-${column}` };
}

/** A row with every envelope present. */
function fullRow(): Record<`${Column}Enc`, unknown> {
  return Object.fromEntries(ALL_COLUMNS.map((c) => [`${c}Enc`, envelope(c)])) as Record<
    `${Column}Enc`,
    unknown
  >;
}

/** decryptField behavior: succeed with "plain-<column>" except listed columns. */
function decryptSucceedingExcept(failing: ReadonlyArray<Column>): void {
  decryptMock.mockImplementation(
    async (input: { binding: { column: string } }): Promise<string> => {
      if ((failing as ReadonlyArray<string>).includes(input.binding.column)) {
        throw new Error(`synthetic decrypt failure for ${input.binding.column}`);
      }
      return `plain-${input.binding.column}`;
    }
  );
}

beforeEach(() => {
  decryptMock.mockReset();
  loggerMock.warn.mockReset();
});

describe("decryptPatientFields — happy path", () => {
  it("decrypts every present envelope and reports no errors", async () => {
    decryptSucceedingExcept([]);

    const result = await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row: fullRow(),
    });

    expect(result.phiDecryptErrors).toBe(false);
    for (const column of ALL_COLUMNS) {
      expect(result.fields[column]).toBe(`plain-${column}`);
    }
    expect(Object.isFrozen(result.fields)).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("null/undefined envelopes map to null WITHOUT calling decrypt and WITHOUT flagging an error", async () => {
    decryptSucceedingExcept([]);
    const row = fullRow();
    row.middleNameEnc = null;
    row.addressLine2Enc = undefined;

    const result = await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row,
    });

    expect(result.phiDecryptErrors).toBe(false);
    expect(result.fields.middleName).toBeNull();
    expect(result.fields.addressLine2).toBeNull();
    // 14 columns minus the two absent envelopes.
    expect(decryptMock).toHaveBeenCalledTimes(12);
  });

  it("binds every decrypt to tenant + table + column + record id (the AAD that blocks cross-tenant envelope replay)", async () => {
    decryptSucceedingExcept([]);

    await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row: fullRow(),
    });

    const bindings = decryptMock.mock.calls.map(
      (call) => (call[0] as { binding: Record<string, string> }).binding
    );
    expect(bindings).toHaveLength(14);
    for (const binding of bindings) {
      expect(binding.tenantId).toBe(ORG_ID);
      expect(binding.table).toBe("patient");
      expect(binding.recordId).toBe(PATIENT_ID);
    }
    expect(new Set(bindings.map((b) => b.column))).toEqual(new Set(ALL_COLUMNS));
  });
});

describe("decryptPatientFields — per-field failure (never a throw)", () => {
  it("a single failing field comes back null with phiDecryptErrors=true while every other field still decrypts", async () => {
    decryptSucceedingExcept(["ssnLast4"]);

    const result = await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row: fullRow(),
    });

    expect(result.phiDecryptErrors).toBe(true);
    expect(result.fields.ssnLast4).toBeNull();
    for (const column of ALL_COLUMNS.filter((c) => c !== "ssnLast4")) {
      expect(result.fields[column]).toBe(`plain-${column}`);
    }
  });

  it("mixed success/fail shape: exactly the failing fields are null, the flag is set once", async () => {
    decryptSucceedingExcept(["firstName", "addressLine1", "mrn"]);

    const result = await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row: fullRow(),
    });

    expect(result.phiDecryptErrors).toBe(true);
    expect(result.fields.firstName).toBeNull();
    expect(result.fields.addressLine1).toBeNull();
    expect(result.fields.mrn).toBeNull();
    expect(result.fields.lastName).toBe("plain-lastName");
    expect(result.fields.city).toBe("plain-city");
  });

  it("all-fields-fail (KMS outage) still resolves — all nulls + flag, not a 500", async () => {
    decryptSucceedingExcept([...ALL_COLUMNS]);

    const result = await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row: fullRow(),
    });

    expect(result.phiDecryptErrors).toBe(true);
    for (const column of ALL_COLUMNS) {
      expect(result.fields[column]).toBeNull();
    }
  });

  it("logs each field failure with binding metadata only — no plaintext, no envelope bytes", async () => {
    decryptSucceedingExcept(["phone"]);

    await decryptPatientFields({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      row: fullRow(),
    });

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [event, context] = loggerMock.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("ops.patient.decrypt.field_failed");
    expect(context["tenantId"]).toBe(ORG_ID);
    expect(context["table"]).toBe("patient");
    expect(context["column"]).toBe("phone");
    expect(context["recordId"]).toBe(PATIENT_ID);
    // The log context must never carry decrypted values or ciphertext.
    const serialized = JSON.stringify({ ...context, error: undefined });
    expect(serialized).not.toContain("plain-");
    expect(serialized).not.toContain("ct-");
  });
});
