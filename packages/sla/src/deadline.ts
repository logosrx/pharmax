// Order SLA deadline computation.
//
// At intake the order's wall-clock `slaDeadlineAt` is computed
// once: `receivedAt + round(budgetMs * priorityMultiplier)`. A
// later slice wires this into `CreateOrder`; the function is pure
// so it's trivially testable and reusable by a recompute path
// (e.g. if an order's priority is escalated).

import type { OrderPriority } from "@pharmax/database";

import { DEFAULT_END_TO_END_SLA_BUDGET_MS, PRIORITY_SLA_MULTIPLIER } from "./thresholds.js";

export interface ComputeOrderSlaDeadlineInput {
  /** Intake timestamp the budget is measured from. */
  readonly receivedAt: Date;
  /** Order priority — selects the budget multiplier. */
  readonly priority: OrderPriority;
  /**
   * End-to-end budget in ms before priority scaling. Defaults to
   * the sum of the per-stage thresholds. A per-org `sla_threshold`
   * override passes its own budget here.
   */
  readonly budgetMs?: number;
}

/**
 * Compute the order-level SLA deadline. Pure: same inputs → same
 * Date.
 */
export function computeOrderSlaDeadline(input: ComputeOrderSlaDeadlineInput): Date {
  const budget = input.budgetMs ?? DEFAULT_END_TO_END_SLA_BUDGET_MS;
  const multiplier = PRIORITY_SLA_MULTIPLIER[input.priority];
  const scaledMs = Math.round(budget * multiplier);
  return new Date(input.receivedAt.getTime() + scaledMs);
}
