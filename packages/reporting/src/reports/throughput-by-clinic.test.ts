import { afterEach, describe, expect, it, vi } from "vitest";

import { throughputByClinicReport } from "./throughput-by-clinic.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "00000000-0000-4000-8000-0000000000a1";
const CLINIC_B = "00000000-0000-4000-8000-0000000000b2";

const SHIPPED_AT = new Date("2026-05-10T12:00:00.000Z");

interface FakeOrder {
  clinicId: string;
  receivedAt: Date;
  shippedAt: Date | null;
}

/** An order that took `turnaroundHours` from intake to shipment. */
function order(clinicId: string, turnaroundHours: number): FakeOrder {
  return {
    clinicId,
    receivedAt: new Date(SHIPPED_AT.getTime() - turnaroundHours * 3_600_000),
    shippedAt: SHIPPED_AT,
  };
}

function fakeClient(orders: ReadonlyArray<FakeOrder>) {
  return { order: { findMany: vi.fn(async (_args: unknown) => orders) } };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("throughputByClinicReport — volume + turnaround", () => {
  it("counts shipments per clinic and summarizes end-to-end turnaround", async () => {
    const client = fakeClient([
      order(CLINIC_A, 4),
      order(CLINIC_A, 8),
      order(CLINIC_A, 12),
      order(CLINIC_B, 30),
    ]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]).toEqual({
      clinicId: CLINIC_A,
      shippedCount: 3,
      shareOfThroughputBps: 7500, // 3 of 4
      turnaroundSampleCount: 3,
      avgTurnaroundHours: 8,
      // Nearest-rank over 3 samples: p50 is the 2nd, p95 the 3rd.
      p50TurnaroundHours: 8,
      p95TurnaroundHours: 12,
      maxTurnaroundHours: 12,
    });
    expect(result.aggregates).toEqual({
      totalShipped: 4,
      turnaroundSampleCount: 4,
      avgTurnaroundHours: 13.5, // (4 + 8 + 12 + 30) / 4
      p95TurnaroundHours: 30,
      distinctClinics: 2,
    });
  });

  it("weights the org-wide average by order, not by clinic", async () => {
    // A mean of clinic means would report (1 + 100) / 2 = 50.5h. The
    // org shipped 100 fast orders and one slow one; its real average
    // is barely above 1h.
    const client = fakeClient([
      ...Array.from({ length: 100 }, () => order(CLINIC_A, 1)),
      order(CLINIC_B, 100),
    ]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["avgTurnaroundHours"]).toBe(2); // 200h / 101
  });

  it("shows the median far below the mean when one clinic has a long tail", async () => {
    const client = fakeClient([
      ...Array.from({ length: 9 }, () => order(CLINIC_A, 2)),
      order(CLINIC_A, 200),
    ]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.p50TurnaroundHours).toBeLessThan(row.avgTurnaroundHours);
    expect(row.p95TurnaroundHours).toBeGreaterThan(row.avgTurnaroundHours);
  });

  it("returns no rows and zeroed aggregates for an empty window", async () => {
    const client = fakeClient([]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalShipped: 0,
      turnaroundSampleCount: 0,
      avgTurnaroundHours: 0,
      p95TurnaroundHours: 0,
      distinctClinics: 0,
    });
  });

  it("handles a single shipment without dividing by zero or mis-ranking", async () => {
    const client = fakeClient([order(CLINIC_A, 6)]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.shippedCount).toBe(1);
    expect(row.shareOfThroughputBps).toBe(10_000);
    expect(row.avgTurnaroundHours).toBe(6);
    expect(row.p50TurnaroundHours).toBe(6);
    expect(row.p95TurnaroundHours).toBe(6);
  });
});

describe("throughputByClinicReport — bad data", () => {
  it("still counts an order whose clock-skewed duration is impossible", async () => {
    // The order shipped, so throughput must include it; the negative
    // duration must not drag the average toward zero.
    const client = fakeClient([
      order(CLINIC_A, 10),
      {
        clinicId: CLINIC_A,
        receivedAt: SHIPPED_AT,
        shippedAt: new Date(SHIPPED_AT.getTime() - 60_000),
      },
    ]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.shippedCount).toBe(2);
    expect(row.turnaroundSampleCount).toBe(1);
    expect(row.avgTurnaroundHours).toBe(10);
  });

  it("skips a row with no shippedAt rather than counting it as instant", async () => {
    // The query filters these out, but the selected column is
    // nullable and a zero-length turnaround would understate every
    // average.
    const client = fakeClient([
      order(CLINIC_A, 10),
      { clinicId: CLINIC_A, receivedAt: SHIPPED_AT, shippedAt: null },
    ]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]!.shippedCount).toBe(1);
  });
});

describe("throughputByClinicReport — sort order", () => {
  it("puts the busiest clinic first", async () => {
    const client = fakeClient([
      order(CLINIC_B, 1),
      order(CLINIC_A, 1),
      order(CLINIC_A, 1),
      order(CLINIC_A, 1),
    ]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => [r.clinicId, r.shippedCount])).toEqual([
      [CLINIC_A, 3],
      [CLINIC_B, 1],
    ]);
  });

  it("breaks a volume tie on clinic id so the CSV is stable", async () => {
    const client = fakeClient([order(CLINIC_B, 1), order(CLINIC_A, 5)]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.clinicId)).toEqual([CLINIC_A, CLINIC_B]);
  });
});

describe("throughputByClinicReport — query shape", () => {
  it("windows on shippedAt, which is what makes this throughput", async () => {
    const client = fakeClient([]);

    await throughputByClinicReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.order.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    // Windowing on receivedAt would make this an intake cohort — the
    // question `order-volume-by-stage` already answers.
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      shippedAt: { gte: window.from, lte: window.to },
    });
    expect(args.where).not.toHaveProperty("receivedAt");
    // Selecting on shippedAt rather than currentStatus keeps an order
    // that shipped and later moved state in the throughput number.
    expect(args.where).not.toHaveProperty("currentStatus");
    expect(args.select).toEqual({ clinicId: true, receivedAt: true, shippedAt: true });
  });
});

describe("throughputByClinicReport — clinic scope", () => {
  it("narrows to the operator's clinic", async () => {
    const client = fakeClient([]);

    await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_A },
      window
    );

    const args = client.order.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({ clinicId: CLINIC_A });
  });

  it("omits the clinic filter at org scope", async () => {
    const client = fakeClient([]);

    await throughputByClinicReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.order.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).not.toHaveProperty("clinicId");
  });

  it("keeps the share denominator inside the clinic scope", async () => {
    // The share is computed from the rows the scoped query returned,
    // so a clinic-scoped run reads 100% rather than dividing one
    // clinic's volume by the whole org's.
    const client = fakeClient([order(CLINIC_A, 3), order(CLINIC_A, 5)]);

    const result = await throughputByClinicReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_A },
      window
    );

    expect(result.rows[0]!.shareOfThroughputBps).toBe(10_000);
  });
});
