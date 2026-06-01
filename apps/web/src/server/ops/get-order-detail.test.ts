// getOrderDetail contract tests.
//
// Mocks `@pharmax/database` + `@pharmax/crypto` so the helper can
// be tested without a real Prisma client or KMS adapter. Asserts:
//   - Null tenancy miss → null result.
//   - Happy path: decrypts every PHI field, projects to OrderDetail.
//   - A single decrypt failure flips `phiDecryptErrors=true` but
//     does NOT abort — the field comes back as null in the row,
//     and other fields decrypt as normal.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000a1";
const PRESCRIPTION_ID = "00000000-0000-4000-8000-0000000000b1";

const prismaMock = {
  order: { findFirst: vi.fn() },
};

const decryptMock = vi.fn();

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  withOrgScope: (_org: string, fn: () => unknown) => fn(),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

vi.mock("@pharmax/crypto", () => ({
  decryptField: decryptMock,
}));

const { getOrderDetail } = await import("./get-order-detail.js");

function buildOrderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    externalOrderNumber: "EXT-1",
    organizationId: ORG_ID,
    clinicId: CLINIC_ID,
    siteId: SITE_ID,
    currentStatus: "TYPED_READY_FOR_PV1",
    priority: "NORMAL",
    receivedAt: new Date("2026-05-25T10:00:00.000Z"),
    slaDeadlineAt: null,
    currentBucketId: "00000000-0000-4000-8000-000000000b03",
    currentAssigneeUserId: null,
    version: 2,
    patient: {
      id: PATIENT_ID,
      firstNameEnc: { v: 1, ct: "..." },
      lastNameEnc: { v: 1, ct: "..." },
      middleNameEnc: null,
      dateOfBirthEnc: { v: 1, ct: "..." },
      phoneEnc: null,
      emailEnc: null,
      addressLine1Enc: { v: 1, ct: "..." },
      addressLine2Enc: null,
      cityEnc: { v: 1, ct: "..." },
      stateEnc: { v: 1, ct: "..." },
      postalCodeEnc: { v: 1, ct: "..." },
    },
    orderLines: [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        quantityToFill: 30,
        daysSupplyToFill: 30,
        vialLabelId: null,
        lot: null,
        prescription: {
          id: PRESCRIPTION_ID,
          rxNumber: "RX-100001",
          drugNdc: "00781111101",
          drugName: "Lisinopril",
          drugStrength: "10mg",
          drugForm: "tablet",
          refillsRemaining: 5,
          sigEnc: { v: 1, ct: "..." },
          provider: {
            firstName: "Pat",
            lastName: "Provider",
            credential: "MD",
            npi: "1234567890",
          },
        },
      },
    ],
    orderEvents: [
      {
        id: "00000000-0000-4000-8000-0000000000e1",
        eventType: "order.received.v1",
        sequenceNumber: 1,
        occurredAt: new Date("2026-05-25T10:00:00.000Z"),
        actorUserId: "00000000-0000-4000-8000-000000000009",
      },
    ],
    packagePhotos: [
      {
        id: "00000000-0000-4000-8000-0000000000f1",
        capturedAt: new Date("2026-05-25T18:00:00.000Z"),
        capturedByUserId: "00000000-0000-4000-8000-000000000009",
        matchStrategy: "EXTERNAL_ORDER_NUMBER",
        matchedAt: new Date("2026-05-25T18:00:01.000Z"),
        trackingNumber: "1Z999",
        trackingSource: "ORDER",
        contentType: "image/jpeg",
        fileSize: 23_456,
        sha256: "feedface0001",
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("getOrderDetail — happy path", () => {
  it("decrypts every PHI field and projects to OrderDetail", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(buildOrderRow());
    // decryptField is called once per encrypted field. We return
    // a deterministic plaintext per call so we can spot-check the
    // projection.
    let n = 0;
    decryptMock.mockImplementation(async (args: { binding: { column: string } }) => {
      n += 1;
      return `dec(${args.binding.column}#${n})`;
    });

    const result = await getOrderDetail({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(result).not.toBeNull();
    expect(result?.phiDecryptErrors).toBe(false);
    expect(result?.patient.firstName).toMatch(/^dec\(firstName/);
    expect(result?.patient.lastName).toMatch(/^dec\(lastName/);
    expect(result?.patient.middleName).toBeNull(); // envelope was null
    expect(result?.patient.dateOfBirth).toMatch(/^dec\(dateOfBirth/);
    expect(result?.patient.phone).toBeNull();
    expect(result?.lines).toHaveLength(1);
    expect(result?.lines[0]?.sig).toMatch(/^dec\(sig/);
    expect(result?.lines[0]?.prescriberName).toBe("Pat Provider, MD");
    expect(result?.events).toHaveLength(1);
    // Package photos are projected structurally (no decryption).
    expect(result?.packagePhotos).toHaveLength(1);
    expect(result?.packagePhotos[0]?.photoId).toBe("00000000-0000-4000-8000-0000000000f1");
    expect(result?.packagePhotos[0]?.matchStrategy).toBe("EXTERNAL_ORDER_NUMBER");
    expect(result?.packagePhotos[0]?.trackingNumber).toBe("1Z999");
    expect(result?.packagePhotos[0]?.trackingSource).toBe("ORDER");
    expect(result?.packagePhotos[0]?.sha256).toBe("feedface0001");
  });

  it("requests only structural package-photo columns (no notesEnc) newest-first, capped", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(buildOrderRow());
    decryptMock.mockResolvedValue("x");
    await getOrderDetail({ organizationId: ORG_ID, orderId: ORDER_ID });

    const selectArg = prismaMock.order.findFirst.mock.calls[0]![0]!.select.packagePhotos;
    expect(selectArg.orderBy).toEqual({ capturedAt: "desc" });
    expect(selectArg.take).toBe(25);
    expect("notesEnc" in selectArg.select).toBe(false);
    // The matchedOrderId/matchedPatientId are redundant on this
    // relation (it IS the matched order) so they're not selected.
    expect("notesEnc" in selectArg.select).toBe(false);
  });

  it("projects an empty packagePhotos array when the order has none", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(buildOrderRow({ packagePhotos: [] }));
    decryptMock.mockResolvedValue("x");
    const result = await getOrderDetail({ organizationId: ORG_ID, orderId: ORDER_ID });
    expect(result?.packagePhotos).toEqual([]);
  });
});

describe("getOrderDetail — partial decrypt failure", () => {
  it("flags phiDecryptErrors=true and nulls the failed field but keeps the rest", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(buildOrderRow());
    let call = 0;
    decryptMock.mockImplementation(async (args: { binding: { column: string } }) => {
      call += 1;
      // Fail the firstName decrypt; succeed everything else.
      if (args.binding.column === "firstName") {
        throw new Error("crypto-test: corrupt envelope");
      }
      return `dec(${args.binding.column}#${call})`;
    });
    const result = await getOrderDetail({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
    });
    expect(result?.phiDecryptErrors).toBe(true);
    expect(result?.patient.firstName).toBeNull();
    expect(result?.patient.lastName).not.toBeNull();
  });
});

describe("getOrderDetail — tenancy miss", () => {
  it("returns null when the order does not exist for the org", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(null);
    const result = await getOrderDetail({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
    });
    expect(result).toBeNull();
    expect(decryptMock).not.toHaveBeenCalled();
  });
});
