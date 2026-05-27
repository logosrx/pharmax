// State → OrderStageIntervalKind map.
//
// Every non-terminal workflow state has a canonical SLA interval
// kind that is open while the order sits in that state. This data
// is used by:
//
//   - `ReleaseHold` — closes `HOLD_ACTIVE` and opens the kind that
//     corresponds to the `heldFromStatus` recorded on the hold row.
//   - `ReopenForCorrection` — closes the current `WAIT_AFTER_*_REJECT`
//     interval and opens the kind that corresponds to the
//     `reopenToState` parameter.
//
// The map is split into primary and exception sub-tables so the
// exhaustiveness signal for primary states is preserved (adding a
// new primary state without a kind is a compile-time failure),
// while the exception table can be partial (terminal states
// `SHIPPED` / `CANCELLED` intentionally have no open interval —
// they ARE the close).
//
// Pattern lifted from `@pharmax/workflow/status-bucket-map.ts` — same
// rationale, different domain (SLA timing vs queue placement).

import { OrderStageIntervalKind } from "@pharmax/database";
import {
  isPrimaryState,
  isTerminalState,
  type OrderExceptionState,
  type OrderPrimaryState,
  type OrderState,
} from "@pharmax/workflow";

/**
 * Canonical SLA interval kind for each primary workflow state.
 *
 * `Record<OrderPrimaryState, ...>` makes this exhaustive — adding
 * a new primary state without a kind is a compile-time failure.
 *
 * `SHIPPED` maps to `null` because the order is terminal in SLA
 * terms (the SHIPPING_ACTIVE interval is closed by ConfirmShipment
 * and no successor opens). Every other primary state has a kind.
 */
export const STAGE_INTERVAL_KIND_FOR_PRIMARY_STATE: Record<
  OrderPrimaryState,
  OrderStageIntervalKind | null
> = {
  RECEIVED: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
  TYPING_IN_PROGRESS: OrderStageIntervalKind.TYPING_ACTIVE,
  TYPED_READY_FOR_PV1: OrderStageIntervalKind.WAIT_BEFORE_PV1,
  PV1_IN_PROGRESS: OrderStageIntervalKind.PV1_ACTIVE,
  PV1_APPROVED_READY_FOR_FILL: OrderStageIntervalKind.WAIT_BEFORE_FILL,
  FILL_IN_PROGRESS: OrderStageIntervalKind.FILL_ACTIVE,
  FILL_COMPLETED_READY_FOR_FINAL: OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
  FINAL_VERIFICATION_IN_PROGRESS: OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
  FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP: OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
  READY_TO_SHIP: OrderStageIntervalKind.SHIPPING_ACTIVE,
  SHIPPED: null,
};

/**
 * SLA interval kind for each exception state.
 *
 * `Partial<Record<OrderExceptionState, …>>` because terminal
 * `CANCELLED` has no open interval (the close-only entry in
 * `COMMAND_STAGE_INTERVAL_CLOSE_ONLY` terminates SLA for
 * cancelled orders). Other exception states have an explicit
 * mapping.
 *
 * - `TYPING_PENDING_MISSING_INFO` → `WAIT_BEFORE_TYPING`. The
 *   order is awaiting upstream input before typing can proceed;
 *   semantically the same window as a freshly-received order.
 *   When `MarkTypingMissingInfo` lands, this mapping can be
 *   revisited (a dedicated `MISSING_INFO_PENDING` kind would
 *   let reports separate "waiting for upstream" from "waiting
 *   for a free typist" if pharmacy ops cares about the
 *   distinction).
 *
 * - `PV1_REJECTED` → `WAIT_AFTER_PV1_REJECT`. The order is
 *   awaiting rework after a pharmacist rejection. Reports
 *   exclude this kind from per-stage breach windows by default.
 *
 * - `FINAL_VERIFICATION_REJECTED` → `WAIT_AFTER_FINAL_REJECT`.
 *   Symmetric: awaiting rework after a final-verification
 *   rejection.
 *
 * - `ON_HOLD` → `HOLD_ACTIVE`. The active interval kind for the
 *   paused stage. ReleaseHold closes it.
 *
 * - `CANCELLED` (omitted) → terminal; no open interval.
 */
export const STAGE_INTERVAL_KIND_FOR_EXCEPTION_STATE: Partial<
  Record<OrderExceptionState, OrderStageIntervalKind>
> = {
  TYPING_PENDING_MISSING_INFO: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
  PV1_REJECTED: OrderStageIntervalKind.WAIT_AFTER_PV1_REJECT,
  FINAL_VERIFICATION_REJECTED: OrderStageIntervalKind.WAIT_AFTER_FINAL_REJECT,
  ON_HOLD: OrderStageIntervalKind.HOLD_ACTIVE,
};

/**
 * Lookup helper. Returns the SLA interval kind for any state that
 * has a mapping (primary or exception), or `null` for terminal
 * states (`SHIPPED` / `CANCELLED`).
 *
 * Callers that need an open interval kind after a state-restoring
 * operation (ReleaseHold, ReopenForCorrection) MUST handle the
 * `null` case — it indicates the caller asked to "open the
 * interval for a terminal state" which is a programmer error.
 */
export function intervalKindForOrderState(state: OrderState): OrderStageIntervalKind | null {
  if (isTerminalState(state)) {
    return null;
  }
  if (isPrimaryState(state)) {
    return STAGE_INTERVAL_KIND_FOR_PRIMARY_STATE[state as OrderPrimaryState];
  }
  // Falls through to exception. `Object.prototype.hasOwnProperty`
  // guards against accidental prototype lookups even though the
  // map is a plain object literal — defensive against a future
  // refactor that swaps the storage for a class instance.
  if (Object.prototype.hasOwnProperty.call(STAGE_INTERVAL_KIND_FOR_EXCEPTION_STATE, state)) {
    return STAGE_INTERVAL_KIND_FOR_EXCEPTION_STATE[state as OrderExceptionState] ?? null;
  }
  return null;
}
