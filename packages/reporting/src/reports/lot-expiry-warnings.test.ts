import { LotStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lotExpiryWarningsReport } from "./lot-expiry-warnings.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE = "00000000-0000-4000-8000-000000000002";
const PRODUCT = "00000000-0000-4000-8000-000000000003";
const AS_OF = new Date("2026-05-29T12:00:00.000Z");

interface FakeLot {
  siteId: string;
  productId: string;
  lotNumber: string;
  expirationDate: Date;
  status: LotStatus;
  product: { name: string };
}

function fakeClient(lots: ReadonlyArray<FakeLot>) {
  return {
    lot: { findMany: vi.fn(async () => lots) },
  };
}

function lot(expISO: string, overrides: Partial<FakeLot> = {}): FakeLot {
  return {
    siteId: SITE,
    productId: PRODUCT,
    lotNumber: "LOT-1",
    expirationDate: new Date(expISO),
    status: LotStatus.ACTIVE,
    product: { name: "Test Product" },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("lotExpiryWarningsReport — daysUntilExpiry + aggregates", () => {
  it("computes negative days for expired, classifies expiring-soon (<=30d)", async () => {
    const client = fakeClient([
      lot("2026-05-20"), // 9 days ago → expired
      lot("2026-06-10"), // +12 days → soon
      lot("2026-08-01"), // +64 days → not soon
    ]);
    const result = await lotExpiryWarningsReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: AS_OF },
      { withinDays: 90 }
    );

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.daysUntilExpiry).toBe(-9);
    expect(result.rows[1]!.daysUntilExpiry).toBe(12);
    expect(result.rows[2]!.daysUntilExpiry).toBe(64);
    expect(result.aggregates).toEqual({
      totalCount: 3,
      expiredCount: 1,
      expiringSoonCount: 1,
    });
    expect(result.rows[0]!.productName).toBe("Test Product");
  });

  it("returns the window [asOf, asOf + withinDays]", async () => {
    const client = fakeClient([]);
    const result = await lotExpiryWarningsReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: AS_OF },
      { withinDays: 30 }
    );
    expect(result.window.from).toEqual(AS_OF);
    expect(result.window.to.toISOString()).toBe("2026-06-28T12:00:00.000Z");
  });
});

describe("lotExpiryWarningsReport — query shape", () => {
  it("scopes by org, excludes DEPLETED, bounds at the horizon", async () => {
    const client = fakeClient([]);
    await lotExpiryWarningsReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: AS_OF },
      { withinDays: 90 }
    );
    const callArgs = client.lot.findMany.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callArgs[0] as { where: Record<string, unknown> };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["status"]).toEqual({ in: [LotStatus.ACTIVE, LotStatus.ON_HOLD] });
    expect(call.where["expirationDate"]).toHaveProperty("lte");
  });
});

describe("lotExpiryWarningsReport — schema", () => {
  it("defaults withinDays to 90 and rejects < 1", () => {
    expect(lotExpiryWarningsReport.parametersSchema.parse({})).toEqual({ withinDays: 90 });
    expect(lotExpiryWarningsReport.parametersSchema.safeParse({ withinDays: 0 }).success).toBe(
      false
    );
  });
});
