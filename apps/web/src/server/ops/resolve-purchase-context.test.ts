// resolvePurchaseContext — decrypt/refusal path tests
// (coverage-audit 2026-08, backfill item 9; scoped to the PHI
// decrypt and refusal behavior — the full input-assembly matrix is
// out of scope by the audit brief).
//
// The behavior pinned here: the resolver REFUSES to build a purchase
// context from a partially-decrypted recipient address. ANY failed
// envelope — even a field the label doesn't strictly need, like
// addressLine2 or phone — returns the typed
// PATIENT_ADDRESS_DECRYPT_FAILED refusal instead of a context, so a
// blank or wrong-address label can never be purchased off a KMS
// failure. Missing (legitimately null) required fields refuse with
// PATIENT_ADDRESS_INCOMPLETE instead.
//
// Mocks `@pharmax/database` + `@pharmax/crypto`, same as
// `get-order-detail.test.ts`. CLEAN ROOM / PHI: synthetic values only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000a1";

const prismaMock = vi.hoisted(() => ({
  order: { findFirst: vi.fn() },
  carrierCredential: { findMany: vi.fn() },
}));
const decryptMock = vi.hoisted(() => vi.fn());

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

vi.mock("@pharmax/crypto", () => ({ decryptField: decryptMock }));

import {
  resolvePurchaseContext,
  RESOLVE_PURCHASE_NO_ACTIVE_CARRIER_CREDENTIAL,
  RESOLVE_PURCHASE_ORDER_NOT_FOUND,
  RESOLVE_PURCHASE_PATIENT_ADDRESS_DECRYPT_FAILED,
  RESOLVE_PURCHASE_PATIENT_ADDRESS_INCOMPLETE,
  RESOLVE_PURCHASE_SITE_ADDRESS_INCOMPLETE,
} from "./resolve-purchase-context.js";

/** The seven patient columns this resolver decrypts (+ name pair). */
const PATIENT_COLUMNS = [
  "firstName",
  "lastName",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "phone",
] as const;

type PatientColumn = (typeof PATIENT_COLUMNS)[number];

const PLAINTEXT: Record<PatientColumn, string> = {
  firstName: "Pat",
  lastName: "Synthetic",
  addressLine1: "123 Test Ave",
  addressLine2: "Unit 4",
  city: "Testville",
  state: "NC",
  postalCode: "27510",
  phone: "9195550100",
};

function buildOrderRow(input: { nullEnvelopes?: ReadonlyArray<PatientColumn> } = {}) {
  const nulls = input.nullEnvelopes ?? [];
  const enc = (column: PatientColumn) =>
    nulls.includes(column) ? null : { v: 1, ct: `ct-${column}` };
  return {
    id: ORDER_ID,
    siteId: "00000000-0000-4000-8000-000000000003",
    site: {
      name: "Pharmax Test Site",
      addressLine1: "1 Pharmacy Way",
      addressLine2: null,
      city: "Durham",
      state: "NC",
      postalCode: "27701",
      country: "US",
      phone: "9195550200",
    },
    patient: {
      id: PATIENT_ID,
      firstNameEnc: enc("firstName"),
      lastNameEnc: enc("lastName"),
      addressLine1Enc: enc("addressLine1"),
      addressLine2Enc: enc("addressLine2"),
      cityEnc: enc("city"),
      stateEnc: enc("state"),
      postalCodeEnc: enc("postalCode"),
      phoneEnc: enc("phone"),
    },
  };
}

function decryptSucceedingExcept(failing: ReadonlyArray<PatientColumn>): void {
  decryptMock.mockImplementation(
    async (input: { binding: { column: string } }): Promise<string> => {
      if ((failing as ReadonlyArray<string>).includes(input.binding.column)) {
        throw new Error(`synthetic decrypt failure for ${input.binding.column}`);
      }
      return PLAINTEXT[input.binding.column as PatientColumn];
    }
  );
}

beforeEach(() => {
  decryptMock.mockReset();
  prismaMock.order.findFirst.mockReset().mockResolvedValue(buildOrderRow());
  prismaMock.carrierCredential.findMany
    .mockReset()
    .mockResolvedValue([{ provider: "EASYPOST" }, { provider: "FEDEX" }]);
});

describe("resolvePurchaseContext — happy decrypt path", () => {
  it("builds the full context from decrypted PHI with the conservative default parcel", async () => {
    decryptSucceedingExcept([]);

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.toAddress).toEqual({
      name: "Pat Synthetic",
      street1: "123 Test Ave",
      street2: "Unit 4",
      city: "Testville",
      state: "NC",
      postalCode: "27510",
      country: "US",
      phone: "9195550100",
    });
    expect(result.context.parcel).toEqual({
      lengthInches: 3,
      widthInches: 3,
      heightInches: 3,
      weightOunces: 8,
    });
    expect(result.context.availableProviders).toEqual(["EASYPOST", "FEDEX"]);
  });

  it("omits street2/phone (rather than sending blanks) when those envelopes are legitimately absent", async () => {
    decryptSucceedingExcept([]);
    prismaMock.order.findFirst.mockResolvedValue(
      buildOrderRow({ nullEnvelopes: ["addressLine2", "phone"] })
    );

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("street2" in result.context.toAddress).toBe(false);
    expect("phone" in result.context.toAddress).toBe(false);
  });

  it("decrypts with the tenant/table/record binding for every patient column", async () => {
    decryptSucceedingExcept([]);

    await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    const bindings = decryptMock.mock.calls.map(
      (call) => (call[0] as { binding: Record<string, string> }).binding
    );
    expect(bindings).toHaveLength(8);
    for (const binding of bindings) {
      expect(binding.tenantId).toBe(ORG_ID);
      expect(binding.table).toBe("patient");
      expect(binding.recordId).toBe(PATIENT_ID);
    }
    expect(new Set(bindings.map((b) => b.column))).toEqual(new Set(PATIENT_COLUMNS));
  });
});

describe("resolvePurchaseContext — REFUSES a partially-decrypted address", () => {
  it.each(PATIENT_COLUMNS.map((c) => [c] as const))(
    "a decrypt failure on %s alone refuses with PATIENT_ADDRESS_DECRYPT_FAILED — no context, no partial address",
    async (column) => {
      decryptSucceedingExcept([column]);

      const result = await resolvePurchaseContext({
        organizationId: ORG_ID,
        orderId: ORDER_ID,
      });

      expect(result).toEqual({
        ok: false,
        code: RESOLVE_PURCHASE_PATIENT_ADDRESS_DECRYPT_FAILED,
        message: expect.stringContaining("Failed to decrypt the recipient address"),
      });
      expect("context" in result).toBe(false);
    }
  );

  it("all-envelopes-fail (KMS outage) refuses the same way", async () => {
    decryptSucceedingExcept([...PATIENT_COLUMNS]);

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RESOLVE_PURCHASE_PATIENT_ADDRESS_DECRYPT_FAILED);
  });

  it("decrypt failure wins over incompleteness: a failed optional field refuses even when required fields are also missing", async () => {
    // addressLine1 envelope is absent (would be INCOMPLETE) AND phone
    // fails to decrypt — the security refusal must take precedence so
    // the incident is triaged as a KMS/envelope problem, not padded
    // over as a data-entry gap.
    decryptSucceedingExcept(["phone"]);
    prismaMock.order.findFirst.mockResolvedValue(
      buildOrderRow({ nullEnvelopes: ["addressLine1"] })
    );

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RESOLVE_PURCHASE_PATIENT_ADDRESS_DECRYPT_FAILED);
  });

  it("never throws out of a decrypt failure — the refusal is a typed result", async () => {
    decryptMock.mockRejectedValue(new Error("KMS unavailable"));

    await expect(
      resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID })
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("resolvePurchaseContext — incomplete (but cleanly decrypted) addresses", () => {
  it.each([["addressLine1"], ["city"], ["state"], ["postalCode"]] as const)(
    "a missing required field (%s envelope absent) refuses with PATIENT_ADDRESS_INCOMPLETE",
    async (column) => {
      decryptSucceedingExcept([]);
      prismaMock.order.findFirst.mockResolvedValue(
        buildOrderRow({ nullEnvelopes: [column as PatientColumn] })
      );

      const result = await resolvePurchaseContext({
        organizationId: ORG_ID,
        orderId: ORDER_ID,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(RESOLVE_PURCHASE_PATIENT_ADDRESS_INCOMPLETE);
    }
  );

  it("a recipient with neither first nor last name refuses with PATIENT_ADDRESS_INCOMPLETE (no nameless label)", async () => {
    decryptSucceedingExcept([]);
    prismaMock.order.findFirst.mockResolvedValue(
      buildOrderRow({ nullEnvelopes: ["firstName", "lastName"] })
    );

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RESOLVE_PURCHASE_PATIENT_ADDRESS_INCOMPLETE);
  });

  it("a single present name half is enough for the label name", async () => {
    decryptSucceedingExcept([]);
    prismaMock.order.findFirst.mockResolvedValue(buildOrderRow({ nullEnvelopes: ["firstName"] }));

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.toAddress.name).toBe("Synthetic");
  });
});

describe("resolvePurchaseContext — surrounding typed refusals (smoke)", () => {
  it("unknown order in this organization → ORDER_NOT_FOUND before any decrypt", async () => {
    decryptSucceedingExcept([]);
    prismaMock.order.findFirst.mockResolvedValue(null);

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RESOLVE_PURCHASE_ORDER_NOT_FOUND);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("incomplete site address → SITE_ADDRESS_INCOMPLETE before any PHI decrypt", async () => {
    decryptSucceedingExcept([]);
    const row = buildOrderRow();
    prismaMock.order.findFirst.mockResolvedValue({
      ...row,
      site: { ...row.site, postalCode: null },
    });

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RESOLVE_PURCHASE_SITE_ADDRESS_INCOMPLETE);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("no ACTIVE carrier credential → NO_ACTIVE_CARRIER_CREDENTIAL even with a fully decrypted address", async () => {
    decryptSucceedingExcept([]);
    prismaMock.carrierCredential.findMany.mockResolvedValue([]);

    const result = await resolvePurchaseContext({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(RESOLVE_PURCHASE_NO_ACTIVE_CARRIER_CREDENTIAL);
  });
});
