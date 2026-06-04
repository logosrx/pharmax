import { OrderPriority } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_END_TO_END_SLA_BUDGET_MS,
  DEFAULT_STAGE_SLA_THRESHOLDS_MS,
  PRIORITY_SLA_MULTIPLIER,
} from "./thresholds.js";

describe("SLA thresholds", () => {
  it("end-to-end budget equals the sum of the per-stage thresholds", () => {
    const sum = Object.values(DEFAULT_STAGE_SLA_THRESHOLDS_MS).reduce((n, ms) => n + (ms ?? 0), 0);
    expect(DEFAULT_END_TO_END_SLA_BUDGET_MS).toBe(sum);
    // 30+30+30+20+60+45+30+20+240+1440 = 1945 minutes
    expect(DEFAULT_END_TO_END_SLA_BUDGET_MS).toBe(1945 * 60_000);
  });

  it("priority multipliers compress the budget (RUSH half, EMERGENCY quarter)", () => {
    expect(PRIORITY_SLA_MULTIPLIER[OrderPriority.NORMAL]).toBe(1);
    expect(PRIORITY_SLA_MULTIPLIER[OrderPriority.RUSH]).toBe(0.5);
    expect(PRIORITY_SLA_MULTIPLIER[OrderPriority.EMERGENCY]).toBe(0.25);
  });
});
