import { ReopenReason } from "@pharmax/database";

export const REOPEN_REASONS = [
  ReopenReason.TYPING_CORRECTION,
  ReopenReason.PRESCRIPTION_CLARIFICATION,
  ReopenReason.PV1_REWORK,
  ReopenReason.FILL_REDO,
  ReopenReason.LABEL_REWORK,
  ReopenReason.SUPERVISOR_DIRECTED,
  ReopenReason.OTHER,
] as const;

export type ReopenReasonCode = (typeof REOPEN_REASONS)[number];

export const REOPEN_REASONS_SET: ReadonlySet<ReopenReasonCode> = new Set(REOPEN_REASONS);

export function isReopenReason(value: string): value is ReopenReasonCode {
  return REOPEN_REASONS_SET.has(value as ReopenReasonCode);
}

/** Allowed rework target states across all rejection sources. */
export const REOPEN_TARGET_STATES = [
  "TYPING_IN_PROGRESS",
  "TYPED_READY_FOR_PV1",
  "FILL_IN_PROGRESS",
  "FILL_COMPLETED_READY_FOR_FINAL",
] as const;

export type ReopenTargetState = (typeof REOPEN_TARGET_STATES)[number];

export const REOPEN_TARGET_STATES_SET: ReadonlySet<ReopenTargetState> = new Set(
  REOPEN_TARGET_STATES
);

export function isReopenTargetState(value: string): value is ReopenTargetState {
  return REOPEN_TARGET_STATES_SET.has(value as ReopenTargetState);
}
