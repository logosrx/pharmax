// Order workflow policy — version 1.
//
// This file IS THE STATE MACHINE for the standard prescription
// order. Every transition is enumerated; the engine in `engine.ts`
// is generic and policy-agnostic. Adding a new policy version is
// a NEW file (`policy-v2.ts`) + a row in `workflow_policy`; old
// rows continue to evaluate against their original version.
//
// Why one row per (command, fromState) instead of (fromState → set
// of allowed transitions):
//
//   - The transition-row shape is what the audit chain references
//     ("at seq=42, command=APPROVE_PV1 was applied while
//     currentState=PV1_IN_PROGRESS"). One row per transition lets
//     us cite a stable `transitionId` in audit metadata.
//   - It is genuinely exhaustive — TypeScript can prove that
//     `applyTransition` handles every (state, command) pair by
//     walking this table.
//
// Cross-cutting commands (PLACE_HOLD, CANCEL) are expanded into
// one transition row per source state. The allow-list constants
// (`HOLD_FROM_STATES`, `CANCEL_FROM_STATES`) document the rule;
// the transitions array IS the runtime enforcement.

import type { OrderWorkflowCommand } from "./commands.js";
import { type OrderState, ORDER_PRIMARY_STATES, isTerminalState } from "./states.js";

export interface OrderTransitionRow {
  /** Stable id of the transition. Audit metadata cites this. */
  readonly transitionId: string;
  readonly command: OrderWorkflowCommand;
  readonly fromState: OrderState;
  readonly toState: OrderState;
  /**
   * The outbox event type emitted on successful application of
   * this transition. Versioned (`.v1`) so consumers can pin a
   * shape independently of the policy version.
   */
  readonly emits: string;
  /**
   * If true, the engine requires the caller to supply the
   * corresponding parameter on `applyTransition`:
   *
   *   - RELEASE_HOLD → requires `releaseToState`
   *   - REOPEN_FOR_CORRECTION → requires `reopenToState`
   *
   * Static transitions leave this `false`.
   */
  readonly requiresParam?: "releaseToState" | "reopenToState";
}

// ---------------------------------------------------------------
// Primary forward path: RECEIVED → … → SHIPPED.
// ---------------------------------------------------------------
const PRIMARY_FORWARD: ReadonlyArray<OrderTransitionRow> = [
  {
    transitionId: "wf.v1.start_typing",
    command: "START_TYPING",
    fromState: "RECEIVED",
    toState: "TYPING_IN_PROGRESS",
    emits: "order.typing.started.v1",
  },
  {
    transitionId: "wf.v1.complete_typing_review",
    command: "COMPLETE_TYPING_REVIEW",
    fromState: "TYPING_IN_PROGRESS",
    toState: "TYPED_READY_FOR_PV1",
    emits: "order.typing.completed.v1",
  },
  {
    transitionId: "wf.v1.start_pv1",
    command: "START_PV1",
    fromState: "TYPED_READY_FOR_PV1",
    toState: "PV1_IN_PROGRESS",
    emits: "order.pv1.started.v1",
  },
  {
    transitionId: "wf.v1.approve_pv1",
    command: "APPROVE_PV1",
    fromState: "PV1_IN_PROGRESS",
    toState: "PV1_APPROVED_READY_FOR_FILL",
    emits: "order.pv1.approved.v1",
  },
  {
    transitionId: "wf.v1.start_fill",
    command: "START_FILL",
    fromState: "PV1_APPROVED_READY_FOR_FILL",
    toState: "FILL_IN_PROGRESS",
    emits: "order.fill.started.v1",
  },
  {
    transitionId: "wf.v1.complete_fill",
    command: "COMPLETE_FILL",
    fromState: "FILL_IN_PROGRESS",
    toState: "FILL_COMPLETED_READY_FOR_FINAL",
    emits: "order.fill.completed.v1",
  },
  {
    transitionId: "wf.v1.start_final_verification",
    command: "START_FINAL_VERIFICATION",
    fromState: "FILL_COMPLETED_READY_FOR_FINAL",
    toState: "FINAL_VERIFICATION_IN_PROGRESS",
    emits: "order.final.started.v1",
  },
  {
    transitionId: "wf.v1.approve_final_verification",
    command: "APPROVE_FINAL_VERIFICATION",
    fromState: "FINAL_VERIFICATION_IN_PROGRESS",
    toState: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
    emits: "order.final.approved.v1",
  },
  {
    transitionId: "wf.v1.release_to_ship",
    command: "RELEASE_TO_SHIP",
    fromState: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
    toState: "READY_TO_SHIP",
    emits: "order.ship.released.v1",
  },
  {
    transitionId: "wf.v1.confirm_shipment",
    command: "CONFIRM_SHIPMENT",
    fromState: "READY_TO_SHIP",
    toState: "SHIPPED",
    emits: "order.shipped.v1",
  },
];

// ---------------------------------------------------------------
// Exception branches.
// ---------------------------------------------------------------
const EXCEPTION_TRANSITIONS: ReadonlyArray<OrderTransitionRow> = [
  // Typing missing-info loop.
  {
    transitionId: "wf.v1.mark_typing_missing_info",
    command: "MARK_TYPING_MISSING_INFO",
    fromState: "TYPING_IN_PROGRESS",
    toState: "TYPING_PENDING_MISSING_INFO",
    emits: "order.typing.missing_info.v1",
  },
  {
    transitionId: "wf.v1.resume_typing_after_info_received",
    command: "RESUME_TYPING_AFTER_INFO_RECEIVED",
    fromState: "TYPING_PENDING_MISSING_INFO",
    toState: "TYPING_IN_PROGRESS",
    emits: "order.typing.resumed.v1",
  },
  // PV1 rejection.
  {
    transitionId: "wf.v1.reject_pv1",
    command: "REJECT_PV1",
    fromState: "PV1_IN_PROGRESS",
    toState: "PV1_REJECTED",
    emits: "order.pv1.rejected.v1",
  },
  // Final verification rejection.
  {
    transitionId: "wf.v1.reject_final_verification",
    command: "REJECT_FINAL_VERIFICATION",
    fromState: "FINAL_VERIFICATION_IN_PROGRESS",
    toState: "FINAL_VERIFICATION_REJECTED",
    emits: "order.final.rejected.v1",
  },
];

// ---------------------------------------------------------------
// PLACE_HOLD — allowed from every active (non-terminal, non-hold)
// state. Holding from an exception state (e.g. PV1_REJECTED) is
// allowed because operations may want to pause investigation.
// ---------------------------------------------------------------
export const HOLD_FROM_STATES: ReadonlyArray<OrderState> = (
  ORDER_PRIMARY_STATES.filter((s) => !isTerminalState(s)) as ReadonlyArray<OrderState>
).concat(["TYPING_PENDING_MISSING_INFO", "PV1_REJECTED", "FINAL_VERIFICATION_REJECTED"]);

const HOLD_TRANSITIONS: ReadonlyArray<OrderTransitionRow> = HOLD_FROM_STATES.map((from) => ({
  transitionId: `wf.v1.place_hold_from_${from.toLowerCase()}`,
  command: "PLACE_HOLD",
  fromState: from,
  toState: "ON_HOLD",
  emits: "order.held.v1",
}));

// ---------------------------------------------------------------
// RELEASE_HOLD — single source state, dynamic target. The handler
// supplies `releaseToState` (read from the hold record so the
// state machine doesn't need to track pre-hold history).
// ---------------------------------------------------------------
const RELEASE_HOLD_TRANSITIONS: ReadonlyArray<OrderTransitionRow> = [
  {
    transitionId: "wf.v1.release_hold",
    command: "RELEASE_HOLD",
    fromState: "ON_HOLD",
    // Sentinel — the engine inspects `input.releaseToState` and
    // overrides this value. The transition row still declares it
    // for static analysis; the engine never returns this state.
    toState: "ON_HOLD",
    emits: "order.hold_released.v1",
    requiresParam: "releaseToState",
  },
];

// ---------------------------------------------------------------
// REOPEN_FOR_CORRECTION — from rejected states back to an earlier
// stage. The handler supplies `reopenToState` (must be an allowed
// rework target for the source).
// ---------------------------------------------------------------
const REOPEN_TRANSITIONS: ReadonlyArray<OrderTransitionRow> = [
  {
    transitionId: "wf.v1.reopen_from_pv1_rejected",
    command: "REOPEN_FOR_CORRECTION",
    fromState: "PV1_REJECTED",
    toState: "PV1_REJECTED",
    emits: "order.reopened.v1",
    requiresParam: "reopenToState",
  },
  {
    transitionId: "wf.v1.reopen_from_final_rejected",
    command: "REOPEN_FOR_CORRECTION",
    fromState: "FINAL_VERIFICATION_REJECTED",
    toState: "FINAL_VERIFICATION_REJECTED",
    emits: "order.reopened.v1",
    requiresParam: "reopenToState",
  },
];

/**
 * Allowed `reopenToState` values for each rejected source. The
 * engine consults this when validating REOPEN_FOR_CORRECTION;
 * if the caller asks for a state not in this list, the engine
 * returns WORKFLOW_PARAM_INVALID.
 */
export const REOPEN_TARGETS_BY_SOURCE: Readonly<
  Partial<Record<OrderState, ReadonlyArray<OrderState>>>
> = {
  PV1_REJECTED: ["TYPING_IN_PROGRESS", "TYPED_READY_FOR_PV1"],
  FINAL_VERIFICATION_REJECTED: ["FILL_IN_PROGRESS", "FILL_COMPLETED_READY_FOR_FINAL"],
};

// ---------------------------------------------------------------
// CANCEL — terminal-bound. Allowed from every non-terminal state
// (including ON_HOLD and every rejection). NOT allowed from
// SHIPPED or CANCELLED; the engine surfaces those as
// WORKFLOW_STATE_TERMINAL when the source is terminal.
// ---------------------------------------------------------------
export const CANCEL_FROM_STATES: ReadonlyArray<OrderState> = (
  ORDER_PRIMARY_STATES.filter((s) => !isTerminalState(s)) as ReadonlyArray<OrderState>
).concat(["TYPING_PENDING_MISSING_INFO", "PV1_REJECTED", "FINAL_VERIFICATION_REJECTED", "ON_HOLD"]);

const CANCEL_TRANSITIONS: ReadonlyArray<OrderTransitionRow> = CANCEL_FROM_STATES.map((from) => ({
  transitionId: `wf.v1.cancel_from_${from.toLowerCase()}`,
  command: "CANCEL",
  fromState: from,
  toState: "CANCELLED",
  emits: "order.cancelled.v1",
}));

// ---------------------------------------------------------------
// Frozen transition table.
// ---------------------------------------------------------------
export const ORDER_STANDARD_V1_TRANSITIONS: ReadonlyArray<OrderTransitionRow> = Object.freeze([
  ...PRIMARY_FORWARD,
  ...EXCEPTION_TRANSITIONS,
  ...HOLD_TRANSITIONS,
  ...RELEASE_HOLD_TRANSITIONS,
  ...REOPEN_TRANSITIONS,
  ...CANCEL_TRANSITIONS,
]);

export interface OrderWorkflowPolicy {
  readonly code: "order.standard";
  readonly version: 1;
  readonly states: ReadonlyArray<OrderState>;
  readonly terminalStates: ReadonlyArray<OrderState>;
  readonly transitions: ReadonlyArray<OrderTransitionRow>;
}

export const ORDER_STANDARD_V1: OrderWorkflowPolicy = Object.freeze({
  code: "order.standard" as const,
  version: 1 as const,
  states: Object.freeze([
    ...ORDER_PRIMARY_STATES,
    "TYPING_PENDING_MISSING_INFO",
    "PV1_REJECTED",
    "FINAL_VERIFICATION_REJECTED",
    "ON_HOLD",
    "CANCELLED",
  ] as OrderState[]),
  terminalStates: Object.freeze(["SHIPPED", "CANCELLED"] as OrderState[]),
  transitions: ORDER_STANDARD_V1_TRANSITIONS,
});
