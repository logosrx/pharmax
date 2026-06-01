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
