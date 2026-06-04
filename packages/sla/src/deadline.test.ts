import { OrderPriority } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import { computeOrderSlaDeadline } from "./deadline.js";
import { DEFAULT_END_TO_END_SLA_BUDGET_MS } from "./thresholds.js";

const RECEIVED = new Date("2026-06-01T00:00:00.000Z");

describe("computeOrderSlaDeadline", () => {
  it("NORMAL = receivedAt + full budget", () => {
    const d = computeOrderSlaDeadline({ receivedAt: RECEIVED, priority: OrderPriority.NORMAL });
    expect(d.getTime()).toBe(RECEIVED.getTime() + DEFAULT_END_TO_END_SLA_BUDGET_MS);
  });

  it("RUSH = half budget", () => {
    const d = computeOrderSlaDeadline({ receivedAt: RECEIVED, priority: OrderPriority.RUSH });
    expect(d.getTime()).toBe(
      RECEIVED.getTime() + Math.round(DEFAULT_END_TO_END_SLA_BUDGET_MS * 0.5)
    );
  });

  it("EMERGENCY = quarter budget", () => {
    const d = computeOrderSlaDeadline({ receivedAt: RECEIVED, priority: OrderPriority.EMERGENCY });
    expect(d.getTime()).toBe(
      RECEIVED.getTime() + Math.round(DEFAULT_END_TO_END_SLA_BUDGET_MS * 0.25)
    );
  });

  it("honors a custom budget override", () => {
    const d = computeOrderSlaDeadline({
      receivedAt: RECEIVED,
      priority: OrderPriority.NORMAL,
      budgetMs: 60_000,
    });
    expect(d.getTime()).toBe(RECEIVED.getTime() + 60_000);
  });
});
