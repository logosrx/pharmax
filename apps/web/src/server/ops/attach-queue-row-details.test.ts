import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OPERATOR_ID = "00000000-0000-4000-8000-000000000009";
const PATIENT_A = "00000000-0000-4000-8000-0000000000a1";
const PATIENT_B = "00000000-0000-4000-8000-0000000000a2";
const ORDER_1 = "00000000-0000-4000-8000-0000000000f1";
const ORDER_2 = "00000000-0000-4000-8000-0000000000f2";

const prismaMock = { order: { findMany: vi.fn() } };
const auditMock = vi.fn();
const decryptMock = vi.fn();

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));
vi.mock("./audit-patient-view.js", () => ({ auditPatientViewsBatch: auditMock }));
vi.mock("./decrypt-patient.js", () => ({ decryptPatientName: decryptMock }));

const { attachQueueRowDetails } = await import("./attach-queue-row-details.js");

/** A joined order as the projection selects it. */
function joinedOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_1,
    patientId: PATIENT_A,
    clinic: { code: "NORTHSIDE", name: "Northside Clinic" },
    patient: { firstNameEnc: { c: "1" }, lastNameEnc: { c: "2" }, cryptoShreddedAt: null },
    orderLines: [
      {
        prescription: {
          drugName: "Amoxicillin",
          drugStrength: "500 mg",
          drugForm: "capsule",
          controlledSubstanceSchedule: "NON_CONTROLLED",
          provider: { npi: "1234567893", firstName: "Dana", lastName: "Reyes", credential: "MD" },
        },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  auditMock.mockResolvedValue({ attempted: 1, succeeded: 1, failedPatientIds: [] });
  decryptMock.mockResolvedValue({ firstName: "Alex", lastName: "Kim", phiDecryptErrors: false });
});
afterEach(() => vi.clearAllMocks());

describe("attachQueueRowDetails", () => {
  it("does no work at all for an empty page", async () => {
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [],
    });
    expect(result.rows).toEqual([]);
    // Critically, no audit dispatch: an empty queue must not write
    // access records for patients nobody looked at.
    expect(auditMock).not.toHaveBeenCalled();
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it("attaches client, prescriber, drugs and the patient name", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([joinedOrder()]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(result.rows[0]).toMatchObject({
      orderId: ORDER_1,
      clinicCode: "NORTHSIDE",
      clinicName: "Northside Clinic",
      patientName: "Alex Kim",
      patientNameWithheld: false,
    });
    expect(result.rows[0]?.prescribers).toEqual([
      { displayName: "Dana Reyes, MD", npi: "1234567893" },
    ]);
    expect(result.rows[0]?.medications).toEqual([
      {
        drugName: "Amoxicillin",
        drugStrength: "500 mg",
        drugForm: "capsule",
        isControlled: false,
      },
    ]);
  });

  it("audits the patient view under the WORK_QUEUE surface before returning", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([joinedOrder()]);
    await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(auditMock).toHaveBeenCalledOnce();
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      surface: "WORK_QUEUE",
      patients: [{ patientId: PATIENT_A, phiDecryptErrors: false }],
    });
  });

  it("masks the name but KEEPS the order when the audit write fails", async () => {
    // The deliberate divergence from patient search, where a failed
    // audit withholds the whole row. Hiding pharmacy work is worse than
    // hiding a name.
    auditMock.mockResolvedValueOnce({
      attempted: 1,
      succeeded: 0,
      failedPatientIds: [PATIENT_A],
    });
    prismaMock.order.findMany.mockResolvedValueOnce([joinedOrder()]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.orderId).toBe(ORDER_1);
    expect(result.rows[0]?.patientName).toBeNull();
    expect(result.rows[0]?.patientNameWithheld).toBe(true);
    expect(result.patientNamesWithheld).toBe(1);
    // The rest of the row survives — the order is still workable.
    expect(result.rows[0]?.clinicCode).toBe("NORTHSIDE");
    expect(result.rows[0]?.medications).toHaveLength(1);
  });

  it("distinguishes an undecryptable name from a withheld one", async () => {
    decryptMock.mockResolvedValueOnce({
      firstName: null,
      lastName: null,
      phiDecryptErrors: true,
    });
    prismaMock.order.findMany.mockResolvedValueOnce([joinedOrder()]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(result.rows[0]?.patientName).toBeNull();
    // Not withheld: the audit succeeded, the crypto did not.
    expect(result.rows[0]?.patientNameWithheld).toBe(false);
    expect(result.patientNamesWithheld).toBe(0);
    expect(result.phiDecryptErrors).toBe(1);
  });

  it("reports a decrypt failure to the audit record", async () => {
    decryptMock.mockResolvedValueOnce({
      firstName: null,
      lastName: null,
      phiDecryptErrors: true,
    });
    prismaMock.order.findMany.mockResolvedValueOnce([joinedOrder()]);
    await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      patients: [{ patientId: PATIENT_A, phiDecryptErrors: true }],
    });
  });

  it("decrypts and audits once per distinct patient, not once per order", async () => {
    // Two orders for one patient is normal in a queue. Paying twice
    // would double both the KMS cost and the audit volume.
    prismaMock.order.findMany.mockResolvedValueOnce([joinedOrder(), joinedOrder({ id: ORDER_2 })]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }, { orderId: ORDER_2 }],
    });
    expect(decryptMock).toHaveBeenCalledOnce();
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      patients: [{ patientId: PATIENT_A, phiDecryptErrors: false }],
    });
    // Both rows still get the name.
    expect(result.rows[0]?.patientName).toBe("Alex Kim");
    expect(result.rows[1]?.patientName).toBe("Alex Kim");
  });

  it("never decrypts a crypto-shredded patient", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([
      joinedOrder({
        patient: {
          firstNameEnc: null,
          lastNameEnc: null,
          cryptoShreddedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      }),
    ]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(result.rows[0]?.patientName).toBeNull();
    // No audit either: there was no ePHI to access.
    expect(auditMock.mock.calls[0]![0]).toMatchObject({ patients: [] });
  });

  it("marks a controlled prescription so the card can flag it", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([
      joinedOrder({
        orderLines: [
          {
            prescription: {
              drugName: "Oxycodone",
              drugStrength: "5 mg",
              drugForm: "tablet",
              controlledSubstanceSchedule: "CII",
              provider: {
                npi: "1234567893",
                firstName: "Dana",
                lastName: "Reyes",
                credential: null,
              },
            },
          },
        ],
      }),
    ]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(result.rows[0]?.medications[0]?.isControlled).toBe(true);
    // No credential means no trailing comma in the display name.
    expect(result.rows[0]?.prescribers[0]?.displayName).toBe("Dana Reyes");
  });

  it("lists every distinct prescriber on a multi-prescriber order", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([
      joinedOrder({
        orderLines: [
          {
            prescription: {
              drugName: "Drug A",
              drugStrength: null,
              drugForm: null,
              controlledSubstanceSchedule: "NON_CONTROLLED",
              provider: { npi: "1111111111", firstName: "Ann", lastName: "Lee", credential: "MD" },
            },
          },
          {
            prescription: {
              drugName: "Drug B",
              drugStrength: null,
              drugForm: null,
              controlledSubstanceSchedule: "NON_CONTROLLED",
              provider: { npi: "2222222222", firstName: "Bo", lastName: "Ray", credential: "NP" },
            },
          },
          {
            // Same prescriber as the first line — must not repeat.
            prescription: {
              drugName: "Drug C",
              drugStrength: null,
              drugForm: null,
              controlledSubstanceSchedule: "NON_CONTROLLED",
              provider: { npi: "1111111111", firstName: "Ann", lastName: "Lee", credential: "MD" },
            },
          },
        ],
      }),
    ]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(result.rows[0]?.prescribers.map((p) => p.npi)).toEqual(["1111111111", "2222222222"]);
    expect(result.rows[0]?.medications).toHaveLength(3);
  });

  it("keeps a row whose order vanished between the two reads", async () => {
    // The order left the bucket mid-render. Dropping it would make the
    // page count disagree with itself; it is gone next refresh anyway.
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      rows: [{ orderId: ORDER_1 }],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.patientName).toBeNull();
    expect(result.rows[0]?.clinicCode).toBe("—");
  });

  it("preserves the caller's row order and extra fields", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([
      joinedOrder({ id: ORDER_2, patientId: PATIENT_B }),
      joinedOrder(),
    ]);
    const result = await attachQueueRowDetails({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      // Deliberately the opposite order to the query result: the
      // queue's SLA-shaped ordering is the one that must survive.
      rows: [
        { orderId: ORDER_1, priority: "RUSH" },
        { orderId: ORDER_2, priority: "NORMAL" },
      ],
    });
    expect(result.rows.map((r) => r.orderId)).toEqual([ORDER_1, ORDER_2]);
    expect(result.rows[0]?.priority).toBe("RUSH");
    expect(result.rows[1]?.priority).toBe("NORMAL");
  });
});
