// workflow.ts — the canonical UI vocabulary for order state.
//
// One place maps every order status + priority to a human label and a
// Badge `tone`, so the typing/PV1/fill/final/shipping queues and the
// order-detail timeline all speak the same visual language. Backend
// enums are authoritative; this is presentation only.

import type { Tone } from "./badge.js";

export interface StatusMeta {
  /** Short, human label (e.g. "Ready for PV1"). */
  readonly label: string;
  readonly tone: Tone;
  /** Workflow stage this status belongs to (for grouping/timeline). */
  readonly stage: WorkflowStage;
  /** True for exception/off-happy-path states. */
  readonly exception?: boolean;
}

export type WorkflowStage =
  | "intake"
  | "typing"
  | "pv1"
  | "fill"
  | "final"
  | "shipping"
  | "done"
  | "exception";

export const STAGE_ORDER: ReadonlyArray<WorkflowStage> = [
  "intake",
  "typing",
  "pv1",
  "fill",
  "final",
  "shipping",
  "done",
];

export const STAGE_LABEL: Record<WorkflowStage, string> = {
  intake: "Intake",
  typing: "Typing",
  pv1: "PV1",
  fill: "Fill",
  final: "Final",
  shipping: "Shipping",
  done: "Shipped",
  exception: "Exception",
};

const STATUS_META: Record<string, StatusMeta> = {
  RECEIVED: { label: "Received", tone: "neutral", stage: "intake" },
  TYPING_IN_PROGRESS: { label: "Typing", tone: "info", stage: "typing" },
  TYPED_READY_FOR_PV1: { label: "Ready for PV1", tone: "brand", stage: "pv1" },
  PV1_IN_PROGRESS: { label: "PV1 in progress", tone: "info", stage: "pv1" },
  PV1_APPROVED_READY_FOR_FILL: { label: "Ready for fill", tone: "brand", stage: "fill" },
  FILL_IN_PROGRESS: { label: "Filling", tone: "info", stage: "fill" },
  FILL_COMPLETED_READY_FOR_FINAL: { label: "Ready for final", tone: "brand", stage: "final" },
  FINAL_VERIFICATION_IN_PROGRESS: { label: "Final in progress", tone: "info", stage: "final" },
  FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP: {
    label: "Ready to ship",
    tone: "brand",
    stage: "shipping",
  },
  READY_TO_SHIP: { label: "Ready to ship", tone: "brand", stage: "shipping" },
  SHIPPED: { label: "Shipped", tone: "success", stage: "done" },

  // Exceptions.
  TYPING_PENDING_MISSING_INFO: {
    label: "Missing info",
    tone: "warning",
    stage: "typing",
    exception: true,
  },
  PV1_REJECTED: { label: "PV1 rejected", tone: "warning", stage: "exception", exception: true },
  FINAL_VERIFICATION_REJECTED: {
    label: "Final rejected",
    tone: "warning",
    stage: "exception",
    exception: true,
  },
  ON_HOLD: { label: "On hold", tone: "warning", stage: "exception", exception: true },
  CANCELLED: { label: "Cancelled", tone: "danger", stage: "exception", exception: true },
};

/** Title-case a SCREAMING_SNAKE enum as a readable fallback label. */
function humanize(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? { label: humanize(status), tone: "neutral", stage: "exception" };
}

export interface PriorityMeta {
  readonly label: string;
  readonly tone: Tone;
}

const PRIORITY_META: Record<string, PriorityMeta> = {
  EMERGENCY: { label: "Emergency", tone: "danger" },
  RUSH: { label: "Rush", tone: "warning" },
  ROUTINE: { label: "Routine", tone: "neutral" },
  STANDARD: { label: "Standard", tone: "neutral" },
};

export function priorityMeta(priority: string): PriorityMeta {
  return PRIORITY_META[priority] ?? { label: humanize(priority), tone: "neutral" };
}
