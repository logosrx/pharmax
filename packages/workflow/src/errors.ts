// Error codes emitted by the workflow engine.
//
// We DO NOT throw from the pure engine — `applyTransition` returns
// a discriminated `TransitionResult` so the bus can decide whether
// the failure is a 409 (workflow guard) or a 400 (input shape).
// The bus is the only place that constructs `PharmaxError`
// instances from these codes; centralizing the code constants
// here keeps the bus / engine / tests in agreement.
//
// Stable string codes; never reuse a code if its semantics change.

export const WORKFLOW_INVALID_TRANSITION = "WORKFLOW_INVALID_TRANSITION" as const;
export const WORKFLOW_STATE_TERMINAL = "WORKFLOW_STATE_TERMINAL" as const;
export const WORKFLOW_PARAM_REQUIRED = "WORKFLOW_PARAM_REQUIRED" as const;
export const WORKFLOW_PARAM_INVALID = "WORKFLOW_PARAM_INVALID" as const;
export const WORKFLOW_UNKNOWN_COMMAND = "WORKFLOW_UNKNOWN_COMMAND" as const;

export type WorkflowErrorCode =
  | typeof WORKFLOW_INVALID_TRANSITION
  | typeof WORKFLOW_STATE_TERMINAL
  | typeof WORKFLOW_PARAM_REQUIRED
  | typeof WORKFLOW_PARAM_INVALID
  | typeof WORKFLOW_UNKNOWN_COMMAND;
