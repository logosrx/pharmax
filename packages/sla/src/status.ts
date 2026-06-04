// SLA breach-status classification.
//
// The single pure function that the live breach-evaluator tick
// AND the queue-badge UI both call, so "yellow vs red" is decided
// in exactly one place:
//
//   NONE      — no deadline set (slaDeadlineAt null) → no badge.
//   ON_TRACK  — comfortably before the deadline (green).
//   WARNING   — within the warning window of the deadline (yellow).
//   BREACHED  — at or past the deadline (red → emergency routing).
//
// Boundaries are inclusive at the breach edge (now === deadline is
// BREACHED) and at the warning edge (now === deadline - window is
// WARNING) so a tick that fires exactly on the boundary classifies
// deterministically.

export type SlaStatus = "NONE" | "ON_TRACK" | "WARNING" | "BREACHED";

export interface ClassifySlaStatusInput {
  /** The order's deadline; null when no SLA was computed. */
  readonly slaDeadlineAt: Date | null;
  /** Evaluation time (the tick's "now", or the UI render time). */
  readonly now: Date;
  /**
   * How far before the deadline an order is flagged WARNING.
   * Defaults to `DEFAULT_SLA_WARNING_WINDOW_MS`.
   */
  readonly warningWindowMs?: number;
}

import { DEFAULT_SLA_WARNING_WINDOW_MS } from "./thresholds.js";

export function classifySlaStatus(input: ClassifySlaStatusInput): SlaStatus {
  if (input.slaDeadlineAt === null) return "NONE";
  const window = input.warningWindowMs ?? DEFAULT_SLA_WARNING_WINDOW_MS;
  const deadlineMs = input.slaDeadlineAt.getTime();
  const nowMs = input.now.getTime();
  if (nowMs >= deadlineMs) return "BREACHED";
  if (nowMs >= deadlineMs - window) return "WARNING";
  return "ON_TRACK";
}

/**
 * Milliseconds until the deadline (negative when already past).
 * Returns null when there is no deadline. Handy for sorting a
 * queue "most urgent first" and for rendering a countdown.
 */
export function msUntilSlaDeadline(input: {
  readonly slaDeadlineAt: Date | null;
  readonly now: Date;
}): number | null {
  if (input.slaDeadlineAt === null) return null;
  return input.slaDeadlineAt.getTime() - input.now.getTime();
}
