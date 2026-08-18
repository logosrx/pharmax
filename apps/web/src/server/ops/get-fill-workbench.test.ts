// getFillWorkbench + assertWorkstationBelongsToSite contract tests.
//
// Asserts:
//   - Happy path projects lines + candidate-lot pools per NDC +
//     site-scoped printers + site-scoped workstations.
//   - Candidate lots are filtered by site, status, expiry, NDC.
//   - readyForCompletionScans flips only when every line has BOTH
//     a lot and a vial-label.
//   - Workstation auth helper rejects cross-site and inactive
//     workstations.

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DatabaseModule from "@pharmax/database";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_SITE_ID = "00000000-0000-4000-8000-000000000011";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";

const prismaMock = {
  order: { findFirst: vi.fn() },
  lot: { findMany: vi.fn() },
  labelPrinter: { findMany: vi.fn() },
  workstation: { findMany: vi.fn(), findFirst: vi.fn() },
};

vi.mock("@pharmax/database", async () => {
  const actual = await vi.importActual<typeof DatabaseModule>("@pharmax/database");
  return {
    ...actual,
    prisma: prismaMock,
    readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
    withOrgScope: (_org: string, fn: () => unknown) => fn(),
    readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
  };
});

const { getFillWorkbench, assertWorkstationBelongsToSite } =
  await import("./get-fill-workbench.js");

function buildOrderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    externalOrderNumber: "EXT-FILL-1",
    currentStatus: "FILL_IN_PROGRESS",
    version: 5,
    currentAssigneeUserId: "00000000-0000-4000-8000-000000000009",
    siteId: SITE_ID,
    orderLines: [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        quantityToFill: 30,
        lot: null,
        compoundingRecords: [],
        vialLabel: null,
        prescription: {
          id: "00000000-0000-4000-8000-0000000000b1",
          rxNumber: "RX-100001",
          drugNdc: "00781111101",
          drugName: "Lisinopril",
          drugStrength: "10mg",
        },
      },
      {
        id: "00000000-0000-4000-8000-0000000000c2",
        quantityToFill: 14,
        lot: { id: "00000000-0000-4000-8000-0000000000d2", lotNumber: "LOT-A2" },
        compoundingRecords: [],
        vialLabel: {
          id: "00000000-0000-4000-8000-0000000000e2",
          barcodeValue: "VL2-bc",
          activePrintJob: { status: "SENT" },
        },
        prescription: {
          id: "00000000-0000-4000-8000-0000000000b2",
          rxNumber: "RX-100002",
          drugNdc: "00781111102",
          drugName: "Amoxicillin",
          drugStrength: "500mg",
        },
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("getFillWorkbench — happy path", () => {
  it("projects lines, groups candidate lots by NDC, surfaces printers + workstations", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(buildOrderRow());
    prismaMock.lot.findMany.mockResolvedValueOnce([
      {
        id: "lot-1",
        lotNumber: "LSN-101",
        expirationDate: new Date("2099-01-01"),
        product: { ndc: "00781111101" },
      },
      {
        id: "lot-2",
        lotNumber: "LSN-102",
        expirationDate: new Date("2099-02-01"),
        product: { ndc: "00781111101" },
      },
      {
        id: "lot-3",
        lotNumber: "LSN-201",
        expirationDate: new Date("2099-03-01"),
        product: { ndc: "00781111102" },
      },
    ]);
    prismaMock.labelPrinter.findMany.mockResolvedValueOnce([
      { id: "p1", code: "PRN-01", name: "Bench 1", workstationId: "w1" },
    ]);
    prismaMock.workstation.findMany.mockResolvedValueOnce([
      { id: "w1", code: "WS-01", name: "Bench 1" },
    ]);

    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });
    expect(result).not.toBeNull();
    expect(result?.lines).toHaveLength(2);
    expect(result?.lines[0]?.candidateLots).toHaveLength(2); // ndc 00781111101 → 2 lots
    expect(result?.lines[1]?.candidateLots).toHaveLength(1); // ndc 00781111102 → 1 lot
    expect(result?.lines[1]?.assignedLot?.lotNumber).toBe("LOT-A2");
    expect(result?.availablePrinters).toHaveLength(1);
    // Only VIAL-stock printers may be offered here. This list feeds the
    // vial-label print form, which defaults to whichever printer sorts
    // first by code — so including a BATCH printer pre-aims the tech at
    // a PRINTER_NOT_THERMAL refusal (it did, once `BATCH-ZPL-01` was
    // seeded and won that sort ahead of `VIAL-ZPL-01`).
    expect(prismaMock.labelPrinter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ labelStock: "VIAL" }),
      })
    );
    expect(result?.availableWorkstations).toHaveLength(1);
    // Line 0 has no lot/label → not ready
    expect(result?.readyForCompletionScans).toBe(false);
  });
});

describe("getFillWorkbench — readyForCompletionScans flips when every line has lot + label", () => {
  it("returns true only when all lines are populated", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(
      buildOrderRow({
        orderLines: [
          {
            id: "c1",
            quantityToFill: 30,
            lot: { id: "lot-x", lotNumber: "LOT-X" },
            compoundingRecords: [],
            vialLabel: {
              id: "vl1",
              barcodeValue: "vl1-bc",
              activePrintJob: { status: "COMPLETED" },
            },
            prescription: {
              id: "rx1",
              rxNumber: "RX1",
              drugNdc: "00781111101",
              drugName: "X",
              drugStrength: null,
            },
          },
        ],
      })
    );
    prismaMock.lot.findMany.mockResolvedValueOnce([]);
    prismaMock.labelPrinter.findMany.mockResolvedValueOnce([]);
    prismaMock.workstation.findMany.mockResolvedValueOnce([]);
    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });
    expect(result?.readyForCompletionScans).toBe(true);
  });
});

describe("getFillWorkbench — compound-prep lines (ADR-0035 slice 4)", () => {
  it("a passing, unexpired compounding record readies a lot-less line", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(
      buildOrderRow({
        orderLines: [
          {
            id: "c1",
            quantityToFill: 1,
            lot: null,
            compoundingRecords: [
              {
                id: "cr-1",
                formulaCode: "MAGIC-MOUTHWASH",
                formulaVersion: 2,
                qualityOutcome: "PASS",
                budAt: new Date("2099-01-01"),
              },
            ],
            vialLabel: {
              id: "vl1",
              barcodeValue: "vl1-bc",
              activePrintJob: { status: "COMPLETED" },
            },
            prescription: {
              id: "rx1",
              rxNumber: "RX1",
              drugNdc: "00781111101",
              drugName: "Magic Mouthwash",
              drugStrength: null,
            },
          },
        ],
      })
    );
    prismaMock.lot.findMany.mockResolvedValueOnce([]);
    prismaMock.labelPrinter.findMany.mockResolvedValueOnce([]);
    prismaMock.workstation.findMany.mockResolvedValueOnce([]);
    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });
    expect(result?.lines[0]?.compoundPrep).toMatchObject({
      formulaCode: "MAGIC-MOUTHWASH",
      qualityOutcome: "PASS",
      budExpired: false,
    });
    expect(result?.readyForCompletionScans).toBe(true);
  });

  it("an expired BUD blocks readiness", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(
      buildOrderRow({
        orderLines: [
          {
            id: "c1",
            quantityToFill: 1,
            lot: null,
            compoundingRecords: [
              {
                id: "cr-1",
                formulaCode: "MAGIC-MOUTHWASH",
                formulaVersion: 2,
                qualityOutcome: "PASS",
                budAt: new Date("2020-01-01"),
              },
            ],
            vialLabel: {
              id: "vl1",
              barcodeValue: "vl1-bc",
              activePrintJob: { status: "COMPLETED" },
            },
            prescription: {
              id: "rx1",
              rxNumber: "RX1",
              drugNdc: "00781111101",
              drugName: "Magic Mouthwash",
              drugStrength: null,
            },
          },
        ],
      })
    );
    prismaMock.lot.findMany.mockResolvedValueOnce([]);
    prismaMock.labelPrinter.findMany.mockResolvedValueOnce([]);
    prismaMock.workstation.findMany.mockResolvedValueOnce([]);
    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });
    expect(result?.lines[0]?.compoundPrep?.budExpired).toBe(true);
    expect(result?.readyForCompletionScans).toBe(false);
  });
});

describe("getFillWorkbench — order not found", () => {
  it("returns null and never queries lots/printers/workstations", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(null);
    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });
    expect(result).toBeNull();
    expect(prismaMock.lot.findMany).not.toHaveBeenCalled();
    expect(prismaMock.labelPrinter.findMany).not.toHaveBeenCalled();
    expect(prismaMock.workstation.findMany).not.toHaveBeenCalled();
  });
});

describe("assertWorkstationBelongsToSite", () => {
  it("returns true when the workstation matches org + site + ACTIVE", async () => {
    prismaMock.workstation.findFirst.mockResolvedValueOnce({ id: "w1" });
    const ok = await assertWorkstationBelongsToSite({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      workstationId: "w1",
    });
    expect(ok).toBe(true);
  });

  it("returns false when the workstation belongs to a different site", async () => {
    prismaMock.workstation.findFirst.mockResolvedValueOnce(null);
    const ok = await assertWorkstationBelongsToSite({
      organizationId: ORG_ID,
      siteId: OTHER_SITE_ID,
      workstationId: "w1",
    });
    expect(ok).toBe(false);
    expect(prismaMock.workstation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: OTHER_SITE_ID,
          status: "ACTIVE",
        }),
      })
    );
  });
});

describe("getFillWorkbench — controlled substances (ADR-0037)", () => {
  /** Prisma Decimal stand-in; the projection needs `lessThan`. */
  function dec(value: number): { lessThan: (other: unknown) => boolean; toString: () => string } {
    return {
      lessThan: (other: unknown) => value < Number(String(other)),
      toString: () => String(value),
    };
  }

  function csOrderRow(options: {
    schedule: string;
    quantityToFill: number;
    quantityAuthorized: number;
  }): Record<string, unknown> {
    return buildOrderRow({
      orderLines: [
        {
          id: "00000000-0000-4000-8000-0000000000c1",
          quantityToFill: dec(options.quantityToFill),
          lot: { id: "00000000-0000-4000-8000-0000000000d1", lotNumber: "LOT-C1" },
          compoundingRecords: [],
          vialLabel: {
            id: "00000000-0000-4000-8000-0000000000e1",
            barcodeValue: "VL1-bc",
            activePrintJob: { status: "COMPLETED" },
          },
          prescription: {
            id: "00000000-0000-4000-8000-0000000000b1",
            rxNumber: "RX-100001",
            drugNdc: "00781111101",
            drugName: "Oxycodone",
            drugStrength: "5mg",
            controlledSubstanceSchedule: options.schedule,
            quantityAuthorized: dec(options.quantityAuthorized),
          },
        },
      ],
    });
  }

  function mockEmptyLookups(): void {
    prismaMock.lot.findMany.mockResolvedValueOnce([]);
    prismaMock.labelPrinter.findMany.mockResolvedValueOnce([]);
    prismaMock.workstation.findMany.mockResolvedValueOnce([]);
  }

  it("leaves controlledSubstance null for a non-controlled line", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(buildOrderRow());
    mockEmptyLookups();

    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result?.lines[0]?.controlledSubstance).toBeNull();
  });

  it("offers only the three Schedule II bases, and requires one when short-supplying", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(
      csOrderRow({ schedule: "CII", quantityToFill: 20, quantityAuthorized: 60 })
    );
    mockEmptyLookups();

    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result?.lines[0]?.controlledSubstance).toMatchObject({
      schedule: "CII",
      quantityAuthorized: "60",
      partialFillBasisRequired: true,
    });
    // § 1306.23's basis must not be offered on a Schedule II line: its
    // completion window does not apply, so picking it would record the
    // wrong deadline.
    expect(result?.lines[0]?.controlledSubstance?.allowedBases).toEqual([
      "PHARMACIST_SUPPLY_SHORTFALL",
      "PATIENT_OR_PRESCRIBER_REQUEST",
      "LTCF_OR_TERMINALLY_ILL",
    ]);
  });

  it("does not require a basis when the fill supplies the full authorized quantity", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(
      csOrderRow({ schedule: "CII", quantityToFill: 60, quantityAuthorized: 60 })
    );
    mockEmptyLookups();

    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result?.lines[0]?.controlledSubstance?.partialFillBasisRequired).toBe(false);
  });

  it("offers the single § 1306.23 basis on a Schedule IV line", async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(
      csOrderRow({ schedule: "CIV", quantityToFill: 30, quantityAuthorized: 30 })
    );
    mockEmptyLookups();

    const result = await getFillWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(result?.lines[0]?.controlledSubstance?.allowedBases).toEqual(["SCHEDULE_III_TO_V"]);
  });
});
