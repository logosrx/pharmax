import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000a1";
const RX_1 = "00000000-0000-4000-8000-0000000000e1";
const RX_2 = "00000000-0000-4000-8000-0000000000e2";
const RX_3 = "00000000-0000-4000-8000-0000000000e3";

const prismaMock = {
  prescription: { findMany: vi.fn(), count: vi.fn() },
};
const decryptFieldMock = vi.fn();
const warnMock = vi.fn();

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));
vi.mock("@pharmax/crypto", () => ({ decryptField: decryptFieldMock }));
vi.mock("../logger.js", () => ({ logger: { warn: warnMock, error: vi.fn(), info: vi.fn() } }));

const { getPatientRxHistory, RX_HISTORY_PAGE_SIZE, RX_HISTORY_MAX_PAGE_SIZE } =
  await import("./get-patient-rx-history.js");

/** A prescription row as the projection selects it. */
function rxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RX_1,
    rxNumber: "RX-1001",
    drugName: "Amoxicillin",
    drugStrength: "500 mg",
    drugForm: "capsule",
    drugNdc: "00093-4155-73",
    sigEnc: { c: "sig" },
    // Prisma hands back a Decimal; only `toString` is relied on.
    quantityAuthorized: { toString: () => "30.0000" },
    daysSupply: 10,
    refillsAuthorized: 2,
    refillsRemaining: 1,
    originalDateWritten: new Date("2026-06-01T00:00:00.000Z"),
    expiresAt: new Date("2027-06-01T00:00:00.000Z"),
    controlledSubstanceSchedule: "NON_CONTROLLED",
    status: "ACTIVE",
    clinic: { code: "NORTHSIDE" },
    provider: {
      id: "00000000-0000-4000-8000-0000000000d1",
      npi: "1234567893",
      firstName: "Dana",
      lastName: "Reyes",
      credential: "MD",
    },
    orderLines: [],
    ...overrides,
  };
}

type FindManyArgs = {
  where: Record<string, unknown>;
  take: number;
  orderBy: Array<Record<string, string>>;
  cursor?: { id: string };
  skip?: number;
};

function findManyArgs(): FindManyArgs {
  const calls = prismaMock.prescription.findMany.mock.calls as unknown as Array<[FindManyArgs]>;
  return calls[0]![0];
}

beforeEach(() => {
  decryptFieldMock.mockResolvedValue("Take one capsule by mouth twice daily");
  prismaMock.prescription.count.mockResolvedValue(1);
});
afterEach(() => vi.clearAllMocks());

describe("getPatientRxHistory", () => {
  it("scopes to the organization and the patient", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(findManyArgs().where).toEqual({ organizationId: ORG_ID, patientId: PATIENT_ID });
  });

  it("projects a prescription with its prescriber, drug and decrypted sig", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow()]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      rxNumber: "RX-1001",
      drugName: "Amoxicillin",
      prescriberDisplayName: "Dana Reyes, MD",
      prescriberNpi: "1234567893",
      clinicCode: "NORTHSIDE",
      sig: "Take one capsule by mouth twice daily",
      daysSupply: 10,
      refillsRemaining: 1,
      refillsAuthorized: 2,
    });
  });

  it("binds the sig decrypt to the prescription row, not the patient", async () => {
    // An AAD bound to the wrong table or record would decrypt nothing
    // and would silently accept a value from another row if it did.
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow()]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(decryptFieldMock.mock.calls[0]![0]).toMatchObject({
      binding: { tenantId: ORG_ID, table: "prescription", column: "sig", recordId: RX_1 },
    });
  });

  it("keeps quantity as a string so the exact authorized amount survives", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow()]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows[0]?.quantityAuthorized).toBe("30.0000");
  });

  it("degrades one row and counts it when a sig will not decrypt", async () => {
    // A KMS fault must not take down the whole medication history: the
    // rest of the record is still what a pharmacist needs.
    decryptFieldMock.mockRejectedValueOnce(new Error("kms unavailable"));
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow()]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sig).toBeNull();
    expect(result.rows[0]?.drugName).toBe("Amoxicillin");
    expect(result.phiDecryptErrors).toBe(1);
  });

  it("logs a decrypt failure with the cause but never the plaintext", async () => {
    decryptFieldMock.mockRejectedValueOnce(new Error("kms unavailable"));
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow()]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(warnMock).toHaveBeenCalledOnce();
    const payload = warnMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload["prescriptionId"]).toBe(RX_1);
    expect(payload["error"]).toBeInstanceOf(Error);
    // No PHI in the log: no sig, no patient id.
    expect(payload).not.toHaveProperty("sig");
    expect(payload).not.toHaveProperty("patientId");
  });

  it("counts every prescription, not just the page", async () => {
    prismaMock.prescription.count.mockResolvedValueOnce(57);
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow()]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.totalPrescriptions).toBe(57);
  });
});

describe("getPatientRxHistory standing", () => {
  it("marks a prescription whose expiry has passed as expired", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    ]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    // Derived from the clock, so it cannot lag behind a sweeper that
    // has not run yet.
    expect(result.rows[0]?.expired).toBe(true);
    expect(result.rows[0]?.status).toBe("ACTIVE");
  });

  it("does not mark a future expiry as expired", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({ expiresAt: new Date("2099-01-01T00:00:00.000Z") }),
    ]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows[0]?.expired).toBe(false);
  });
});

describe("getPatientRxHistory fills", () => {
  it("attaches each dispensing event against the prescription", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({
        orderLines: [
          {
            lineStatus: "FILLED",
            order: {
              id: "00000000-0000-4000-8000-0000000000f1",
              externalOrderNumber: "EXT-9",
              currentStatus: "SHIPPED",
              receivedAt: new Date("2026-06-02T00:00:00.000Z"),
              shippedAt: new Date("2026-06-03T00:00:00.000Z"),
            },
          },
        ],
      }),
    ]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows[0]?.fills).toEqual([
      {
        orderId: "00000000-0000-4000-8000-0000000000f1",
        externalOrderNumber: "EXT-9",
        orderStatus: "SHIPPED",
        lineStatus: "FILLED",
        receivedAt: new Date("2026-06-02T00:00:00.000Z"),
        shippedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
    ]);
  });

  it("preserves an EXCLUDED line so a non-dispense cannot read as a fill", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({
        orderLines: [
          {
            lineStatus: "EXCLUDED",
            order: {
              id: "00000000-0000-4000-8000-0000000000f1",
              externalOrderNumber: null,
              currentStatus: "SHIPPED",
              receivedAt: new Date("2026-06-02T00:00:00.000Z"),
              shippedAt: new Date("2026-06-03T00:00:00.000Z"),
            },
          },
        ],
      }),
    ]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows[0]?.fills[0]?.lineStatus).toBe("EXCLUDED");
  });

  it("reports an empty fills list rather than omitting the prescription", async () => {
    // A written-but-never-dispensed prescription is clinically
    // meaningful and must still appear.
    prismaMock.prescription.findMany.mockResolvedValueOnce([rxRow({ orderLines: [] })]);
    const result = await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.fills).toEqual([]);
  });
});

describe("getPatientRxHistory pagination", () => {
  it("orders newest first with a total sort", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(findManyArgs().orderBy).toEqual([{ originalDateWritten: "desc" }, { id: "asc" }]);
  });

  it("over-fetches by one to detect a further page", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID });
    expect(findManyArgs().take).toBe(RX_HISTORY_PAGE_SIZE + 1);
  });

  it("clamps an oversized limit", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID, limit: 9_999 });
    expect(findManyArgs().take).toBe(RX_HISTORY_MAX_PAGE_SIZE + 1);
  });

  it("drops the probe row and returns its predecessor as the cursor", async () => {
    prismaMock.prescription.count.mockResolvedValueOnce(9);
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({ id: RX_1 }),
      rxRow({ id: RX_2 }),
      rxRow({ id: RX_3 }),
    ]);
    const result = await getPatientRxHistory({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      limit: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBe(RX_2);
  });

  it("reports no next page when the probe row does not come back", async () => {
    prismaMock.prescription.count.mockResolvedValueOnce(2);
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({ id: RX_1 }),
      rxRow({ id: RX_2 }),
    ]);
    const result = await getPatientRxHistory({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      limit: 2,
    });
    expect(result.nextCursor).toBeNull();
  });

  it("skips the cursor row so a page boundary does not repeat it", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([]);
    await getPatientRxHistory({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      cursor: RX_2,
    });
    expect(findManyArgs().cursor).toEqual({ id: RX_2 });
    expect(findManyArgs().skip).toBe(1);
  });

  it("decrypts only the sigs on the returned page, never the probe row", async () => {
    prismaMock.prescription.count.mockResolvedValueOnce(3);
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      rxRow({ id: RX_1 }),
      rxRow({ id: RX_2 }),
      rxRow({ id: RX_3 }),
    ]);
    await getPatientRxHistory({ organizationId: ORG_ID, patientId: PATIENT_ID, limit: 2 });
    // Two, not three: the probe row exists only to answer "is there
    // more" and must not cost a KMS unwrap.
    expect(decryptFieldMock).toHaveBeenCalledTimes(2);
  });
});
