// Workflow state vocabulary.
//
// One source of truth for the prescription-order lifecycle states.
// Mirrors the list in `.cursor/rules/01-workflow-safety.mdc` and
// the seed in `prisma/seed.ts` — drift here is a SOC-2 issue (the
// seeded `workflow_policy.definition.states` JSONB MUST equal
// `ORDER_PRIMARY_STATES ∪ ORDER_EXCEPTION_STATES`).
//
// Two classes of state:
//
//   PRIMARY — the happy-path conveyor belt from intake to ship.
//   EXCEPTION — branches off the happy path for missing info,
//               rejection, hold, and cancellation.
//
// `SHIPPED` and `CANCELLED` are TERMINAL. No command transitions
// out of a terminal state; the state machine rejects every
// attempt with `WORKFLOW_STATE_TERMINAL`.

export const ORDER_PRIMARY_STATES = [
  "RECEIVED",
  "TYPING_IN_PROGRESS",
  "TYPED_READY_FOR_PV1",
  "PV1_IN_PROGRESS",
  "PV1_APPROVED_READY_FOR_FILL",
  "FILL_IN_PROGRESS",
  "FILL_COMPLETED_READY_FOR_FINAL",
  "FINAL_VERIFICATION_IN_PROGRESS",
  "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
  "READY_TO_SHIP",
  "SHIPPED",
] as const;

export const ORDER_EXCEPTION_STATES = [
  "TYPING_PENDING_MISSING_INFO",
  "PV1_REJECTED",
  "FINAL_VERIFICATION_REJECTED",
  "ON_HOLD",
  "CANCELLED",
] as const;

export const ORDER_TERMINAL_STATES = ["SHIPPED", "CANCELLED"] as const;

export const ALL_ORDER_STATES = [...ORDER_PRIMARY_STATES, ...ORDER_EXCEPTION_STATES] as const;

export type OrderPrimaryState = (typeof ORDER_PRIMARY_STATES)[number];
export type OrderExceptionState = (typeof ORDER_EXCEPTION_STATES)[number];
export type OrderTerminalState = (typeof ORDER_TERMINAL_STATES)[number];
export type OrderState = (typeof ALL_ORDER_STATES)[number];

const TERMINAL_SET: ReadonlySet<OrderState> = new Set(ORDER_TERMINAL_STATES);
const PRIMARY_SET: ReadonlySet<OrderState> = new Set(ORDER_PRIMARY_STATES);

export function isTerminalState(state: OrderState): boolean {
  return TERMINAL_SET.has(state);
}

export function isPrimaryState(state: OrderState): boolean {
  return PRIMARY_SET.has(state);
}

export function isOrderState(value: string): value is OrderState {
  return (ALL_ORDER_STATES as ReadonlyArray<string>).includes(value);
}
