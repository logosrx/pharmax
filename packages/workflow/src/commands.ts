// Workflow command vocabulary.
//
// One entry per business event that drives a state transition.
// Stays decoupled from `@pharmax/rbac.PERMISSIONS` because:
//
//   - A single permission may map to multiple commands
//     (`final.approve` can fire both ApproveFinalVerification and
//     overriding-corrective sub-paths in future policy versions).
//   - The state machine is policy-versioned; permissions are not.
//     Two commands with identical permissions can live in
//     different policy versions and be evaluated separately.
//
// Naming convention:
//
//   - `START_*` / `COMPLETE_*` / `APPROVE_*` / `REJECT_*` follow
//     the lifecycle vocabulary in
//     `.cursor/rules/01-workflow-safety.mdc`.
//   - `PLACE_HOLD` / `RELEASE_HOLD` / `CANCEL` are cross-cutting;
//     they are allowed from many source states (see policy).
//   - `REOPEN_FOR_CORRECTION` is parameterized by `reopenToState`
//     because the appropriate rework start point depends on what
//     the verifier flagged.

export const ORDER_WORKFLOW_COMMANDS = [
  "START_TYPING",
  "MARK_TYPING_MISSING_INFO",
  "RESUME_TYPING_AFTER_INFO_RECEIVED",
  "COMPLETE_TYPING_REVIEW",
  "START_PV1",
  "APPROVE_PV1",
  "REJECT_PV1",
  "START_FILL",
  "COMPLETE_FILL",
  "START_FINAL_VERIFICATION",
  "APPROVE_FINAL_VERIFICATION",
  "REJECT_FINAL_VERIFICATION",
  "RELEASE_TO_SHIP",
  "CONFIRM_SHIPMENT",
  "PLACE_HOLD",
  "RELEASE_HOLD",
  "REOPEN_FOR_CORRECTION",
  "CANCEL",
] as const;

export type OrderWorkflowCommand = (typeof ORDER_WORKFLOW_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(ORDER_WORKFLOW_COMMANDS);

export function isOrderWorkflowCommand(value: string): value is OrderWorkflowCommand {
  return COMMAND_SET.has(value);
}
