import { describe, expect, it } from "vitest";

import { rollupByCorrelation, type DeliveryStatusRow } from "./list-notification-deliveries.js";

describe("rollupByCorrelation", () => {
  it("groups counts by correlationId across statuses", () => {
    const rows: ReadonlyArray<DeliveryStatusRow> = [
      { correlationId: "run-1", status: "DELIVERED" },
      { correlationId: "run-1", status: "DELIVERED" },
      { correlationId: "run-1", status: "BOUNCED" },
      { correlationId: "run-2", status: "SENT" },
      { correlationId: "run-2", status: "QUEUED" },
      { correlationId: "run-2", status: "COMPLAINED" },
    ];
    const out = rollupByCorrelation(rows);

    expect(out.get("run-1")).toEqual({
      total: 3,
      delivered: 2,
      bounced: 1,
      complained: 0,
      delayed: 0,
      failed: 0,
      inFlight: 0,
    });
    expect(out.get("run-2")).toEqual({
      total: 3,
      delivered: 0,
      bounced: 0,
      complained: 1,
      delayed: 0,
      failed: 0,
      inFlight: 2,
    });
  });

  it("ignores rows with a null correlationId", () => {
    const rows: ReadonlyArray<DeliveryStatusRow> = [
      { correlationId: null, status: "DELIVERED" },
      { correlationId: "run-1", status: "DELIVERED" },
    ];
    const out = rollupByCorrelation(rows);
    expect(out.size).toBe(1);
    expect(out.get("run-1")?.delivered).toBe(1);
  });

  it("counts CANCELLED + FAILED together as failed", () => {
    const rows: ReadonlyArray<DeliveryStatusRow> = [
      { correlationId: "r", status: "FAILED" },
      { correlationId: "r", status: "CANCELLED" },
      { correlationId: "r", status: "DELIVERY_DELAYED" },
    ];
    const out = rollupByCorrelation(rows);
    expect(out.get("r")).toMatchObject({ failed: 2, delayed: 1, total: 3 });
  });

  it("returns an empty map for no rows", () => {
    expect(rollupByCorrelation([]).size).toBe(0);
  });
});
