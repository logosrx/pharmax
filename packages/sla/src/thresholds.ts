// Canonical SLA thresholds for the pharmacy workflow.
//
// `@pharmax/sla` OWNS these numbers — every other package
// (reporting's sla-breach report, the future breach-evaluator
// tick, the queue-badge UI) imports them from here so there is a
// single source of truth. v1 is hardcoded; the follow-up is a
// per-org `sla_threshold` table that overrides these defaults
// (the deadline + classification functions already take the
// budget as a parameter, so per-org config is a data swap, not a
// code change).
//
// Per-stage thresholds map to the `OrderStageIntervalKind` enum so
// the breach report can attribute a breach to a specific stage.
// The end-to-end budget (sum of all stages) drives the order-level
// `slaDeadlineAt` that the live evaluator + UI badges use.

import { OrderPriority, OrderStageIntervalKind } from "@pharmax/database";

/**
 * Default per-stage SLA thresholds in milliseconds. Picked from
 * LifeFile-style operational defaults; tune per clinic / volume /
 * SLA contract once real data lands.
 */
export const DEFAULT_STAGE_SLA_THRESHOLDS_MS: Readonly<
  Partial<Record<OrderStageIntervalKind, number>>
> = Object.freeze({
  [OrderStageIntervalKind.WAIT_BEFORE_TYPING]: 30 * 60_000, // 30 min
  [OrderStageIntervalKind.TYPING_ACTIVE]: 30 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_PV1]: 30 * 60_000,
  [OrderStageIntervalKind.PV1_ACTIVE]: 20 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_FILL]: 60 * 60_000, // 1h
  [OrderStageIntervalKind.FILL_ACTIVE]: 45 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION]: 30 * 60_000,
  [OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE]: 20 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_SHIPPING]: 4 * 60 * 60_000, // 4h
  [OrderStageIntervalKind.SHIPPING_ACTIVE]: 24 * 60 * 60_000, // 24h
});

/**
 * End-to-end NORMAL-priority SLA budget = the sum of every stage
 * threshold. Computed from the map so the two never drift. At
 * intake the order's `slaDeadlineAt` = `receivedAt + budget *
 * priorityMultiplier`.
 */
export const DEFAULT_END_TO_END_SLA_BUDGET_MS: number = Object.values(
  DEFAULT_STAGE_SLA_THRESHOLDS_MS
).reduce((sum, ms) => sum + (ms ?? 0), 0);

/**
 * Priority compresses the SLA budget: a RUSH order gets half the
 * normal budget, an EMERGENCY order a quarter. Multipliers (not
 * absolute budgets) so a per-org budget override automatically
 * scales across priorities.
 */
export const PRIORITY_SLA_MULTIPLIER: Readonly<Record<OrderPriority, number>> = Object.freeze({
  [OrderPriority.NORMAL]: 1,
  [OrderPriority.RUSH]: 0.5,
  [OrderPriority.EMERGENCY]: 0.25,
});

/**
 * Default "approaching breach" warning window. An order within
 * this much of its deadline is classified WARNING (yellow) before
 * it tips into BREACHED (red).
 */
export const DEFAULT_SLA_WARNING_WINDOW_MS: number = 30 * 60_000; // 30 min
