// Public surface of @pharmax/verification.
//
// Domain package that owns the human-review workflow commands —
// Typing, PV1 (first pharmacist verification), and Final Verification.
// Grouped here (not under `@pharmax/orders`) because every command in
// this package is a state-machine transition gated by RBAC + SoD on
// an existing order row, and because the package boundary is the
// natural seam for future v2 / per-customer workflow policies that
// re-implement these flows.
//
// Convention (mirrors `@pharmax/orgs` and `@pharmax/orders`):
//
//   - Commands are exported individually AND under a `commands`
//     namespace on the `verification` object.
//   - Each command's input/output types are re-exported here so
//     callers depend on `@pharmax/verification`, not on the file
//     path.
//   - Stable error codes are re-exported for the API layer's error
//     translator.

export {
  StartTyping,
  type StartTypingInput,
  type StartTypingOutput,
  TYPING_POLICY_UNSUPPORTED,
  TYPING_ORDER_STATE_UNKNOWN,
  TYPING_INVALID_TRANSITION,
  TYPING_ORDER_TERMINAL,
  TYPING_BUCKET_NOT_CONFIGURED,
  ORDER_VERSION_MISMATCH,
} from "./commands/start-typing.js";

// CompleteTypingReview deliberately REUSES the shared typing-stage
// error codes (`TYPING_POLICY_UNSUPPORTED`, `TYPING_INVALID_TRANSITION`,
// `TYPING_ORDER_TERMINAL`, `TYPING_ORDER_STATE_UNKNOWN`) re-exported
// above from `start-typing.js`, so callers get ONE stable code per
// failure class regardless of which typing command surfaced it. Only
// the destination-bucket-missing code is unique to this command —
// PV1 vs. TYPING bucket misconfiguration are different operator
// remediations.
export {
  CompleteTypingReview,
  type CompleteTypingReviewInput,
  type CompleteTypingReviewOutput,
  PV1_BUCKET_NOT_CONFIGURED,
} from "./commands/complete-typing-review.js";

// StartPV1 defines its own PV1-stage error vocabulary
// (`PV1_POLICY_UNSUPPORTED`, `PV1_INVALID_TRANSITION`,
// `PV1_ORDER_TERMINAL`, `PV1_ORDER_STATE_UNKNOWN`) which will be
// SHARED with `ApprovePV1` / `RejectPV1` when they ship — same
// "one stable code per failure class" pattern as the typing stage.
// `PV1_BUCKET_NOT_CONFIGURED` is REUSED from CompleteTypingReview
// (above) since both commands resolve the same PV1 bucket and a
// missing bucket has the same operator remediation.
export {
  StartPV1,
  type StartPV1Input,
  type StartPV1Output,
  PV1_POLICY_UNSUPPORTED,
  PV1_ORDER_STATE_UNKNOWN,
  PV1_INVALID_TRANSITION,
  PV1_ORDER_TERMINAL,
} from "./commands/start-pv1.js";

// ApprovePV1 is the FIRST `sodRules`-bearing command in the
// codebase — it exercises the bus's
// `requireNoSoDViolationForOrder` path against real `order_event`
// history (using `orderEventTypeToPermission` from `@pharmax/orders`
// as the translator). The relevant rule is
// `sod.typing-pv1-same-actor` from
// `@pharmax/rbac/separation-of-duties.ts`. Callers handling
// approval failures must surface `SOD_VIOLATION`
// (AuthorizationError, 403) distinctly from `PERMISSION_DENIED` —
// the user has the permission, but a prior act by the same actor
// on the same order forbids the operation. ApprovePV1 REUSES the
// PV1-stage error codes from `start-pv1.js`; the
// destination-bucket-missing code (`FILL_BUCKET_NOT_CONFIGURED`)
// is NEW here and will be SHARED with `StartFill` when that ships.
//
// ApprovePV1 ALSO writes a `verification_record` row
// (decision: APPROVED, rejectionReasonCode: null). This was
// added in the `RejectPV1` slice so both decisions land in the
// same indexed table, enabling rejection-rate-by-stage reports
// to be computed off a single read path.
export {
  ApprovePV1,
  type ApprovePV1Input,
  type ApprovePV1Output,
  FILL_BUCKET_NOT_CONFIGURED,
} from "./commands/approve-pv1.js";

// RejectPV1 is the COUNTERPART to ApprovePV1 and the FIRST
// command in the codebase that writes the `verification_record`
// table (the schema's "FIRST table written by a workflow
// command alongside a state transition" milestone).
//
// Two intentional asymmetries with ApprovePV1 to read in the
// handler comment before editing:
//
//   1. NO `sodRules`. The SoD registry rule
//      `sod.typing-pv1-same-actor` is scoped to
//      `attempted: PV1_APPROVE` only — self-rejection by the
//      typist is healthy self-correction and MUST be allowed.
//      Adding `sodRules` here without first adding a registry
//      rule would cost an `orderEvent.findMany` per rejection
//      without enforcing anything; the test suite pins this
//      absence to prevent the regression.
//
//   2. The destination bucket is resolved from
//      `BUCKET_CODE_FOR_EXCEPTION_STATE` (NOT
//      `BUCKET_CODE_FOR_STATUS`, which is exhaustive over
//      primary states only). Today the mapping is
//      `PV1_REJECTED → "TYPING"` (bounce back to typing queue
//      for rework). The destination-bucket-missing code is
//      REUSED as `TYPING_BUCKET_NOT_CONFIGURED` (already
//      re-exported above from `start-typing.js`) — same
//      operator remediation as a missing typing bucket at any
//      other point in the workflow.
//
// `PV1_REJECTION_REASONS` is the frozen reason-code registry
// (string list, not Postgres enum — see
// `rejection-reasons.ts` for the rationale). Callers building
// the rejection UI consume this list directly. New codes land
// here as a code change; no schema migration required.
export { RejectPV1, type RejectPV1Input, type RejectPV1Output } from "./commands/reject-pv1.js";

export {
  PV1_REJECTION_REASONS,
  PV1_REJECTION_REASONS_SET,
  isPV1RejectionReason,
  type PV1RejectionReason,
  FINAL_REJECTION_REASONS,
  FINAL_REJECTION_REASONS_SET,
  isFinalRejectionReason,
  type FinalRejectionReason,
} from "./rejection-reasons.js";

// StartFinalVerification opens the FINAL stage — the SECOND
// pharmacist verification, the last safety check before shipping.
// Two-pharmacist invariant: the SoD registry's
// `sod.pv1-final-same-actor` and `sod.fill-final-same-actor`
// rules prevent the SAME actor from also approving final, but
// they're scoped to `attempted: FINAL_APPROVE` (the sign-off),
// not to `attempted: FINAL_START` (the open-review). This
// handler therefore has NO `sodRules` clause — opening review is
// always allowed; sign-off is the gated act. The test suite
// pins the absence of `orderEvent.findMany` to prevent a future
// "symmetric" SoD addition. Same pattern as `StartPV1` and
// `RejectPV1`.
//
// This command introduces the FINAL-stage error vocabulary
// (`FINAL_POLICY_UNSUPPORTED`, `FINAL_INVALID_TRANSITION`,
// `FINAL_ORDER_TERMINAL`, `FINAL_ORDER_STATE_UNKNOWN`) that
// `ApproveFinalVerification` and `RejectFinalVerification` will
// REUSE — same "one stable code per failure class per stage"
// pattern as the typing and PV1 stages.
// `FINAL_BUCKET_NOT_CONFIGURED` is the destination-bucket-
// missing code for the FINAL bucket itself; siblings will
// introduce their own per-destination codes when they land
// (SHIPPING bucket for Approve, FILL bucket for Reject).
export {
  StartFinalVerification,
  type StartFinalVerificationInput,
  type StartFinalVerificationOutput,
  FINAL_POLICY_UNSUPPORTED,
  FINAL_ORDER_STATE_UNKNOWN,
  FINAL_INVALID_TRANSITION,
  FINAL_ORDER_TERMINAL,
  FINAL_BUCKET_NOT_CONFIGURED,
} from "./commands/start-final-verification.js";

// ApproveFinalVerification is the SECOND `sodRules`-bearing
// command (after `ApprovePV1`) and the FIRST in the codebase
// whose `attempted` permission (`FINAL_APPROVE`) has TWO
// matching SoD rules in the registry:
//
//   - `sod.pv1-final-same-actor` (forbids prior `PV1_APPROVE`
//     by same actor) — the canonical two-pharmacist rule.
//   - `sod.fill-final-same-actor` (forbids prior
//     `FILL_COMPLETE` by same actor) — prevents a
//     fill-and-verify by one person.
//
// The handler declares a SINGLE `sodRules` entry because
// `requireNoSoDViolation` walks all registry rules matching
// `attempted` in one pass; the test suite pins that
// `orderEvent.findMany` fires exactly once and that both rules
// are reachable from real history shapes.
//
// REUSES the FINAL-stage error vocabulary from
// `start-final-verification.js`
// (`FINAL_POLICY_UNSUPPORTED`, `FINAL_INVALID_TRANSITION`,
// `FINAL_ORDER_TERMINAL`, `FINAL_ORDER_STATE_UNKNOWN`).
// INTRODUCES `SHIPPING_BUCKET_NOT_CONFIGURED` — the FIRST
// SHIPPING-bucket resolution in the codebase; will be SHARED
// with `ReleaseToShip` and `ConfirmShipment` when those land.
//
// Also writes a `verification_record` row
// (decision: APPROVED, stage: FINAL, reasonCode: null) —
// identical shape to `ApprovePV1` with `stage: FINAL`, so
// stage-by-decision reports are a single GROUP BY on the
// already-indexed table.
export {
  ApproveFinalVerification,
  type ApproveFinalVerificationInput,
  type ApproveFinalVerificationOutput,
  SHIPPING_BUCKET_NOT_CONFIGURED,
} from "./commands/approve-final-verification.js";

// RejectFinalVerification CLOSES THE VERIFICATION SUITE — the
// pharmacist refuses to release the FILLED vial and bounces the
// order back to FILL for rework (wrong drug pulled, wrong
// strength, expired lot, damaged label, etc.). Two intentional
// asymmetries with `ApproveFinalVerification` and one with
// `RejectPV1`:
//
//   1. NO `sodRules`. Same self-correction rationale as
//      `RejectPV1` — the SoD registry rules
//      `sod.pv1-final-same-actor` and `sod.fill-final-same-actor`
//      are scoped to `attempted: FINAL_APPROVE`, NOT
//      `FINAL_REJECT`. Self-rejection is healthy self-correction
//      ("oh no, I pulled the wrong strength"); forbidding it
//      would push the actor to "approve anyway and ask someone
//      to fix it later" — the worst possible outcome.
//
//   2. Destination bucket is "FILL" (NOT "TYPING" like RejectPV1).
//      By the time the order reaches `FINAL_VERIFICATION_IN_PROGRESS`,
//      typing and PV1 have BOTH already passed — what failed is
//      the physical fill, so the work to redo is the fill itself.
//      Routing back to typing would force re-validation of an
//      already-validated prescription. The FILL bucket lookup
//      REUSES the `FILL_BUCKET_NOT_CONFIGURED` code from
//      `ApprovePV1` (same operator remediation for any command
//      that needs the FILL bucket).
//
//   3. Different reason-code registry. `FINAL_REJECTION_REASONS`
//      describes FILL errors (`WRONG_DRUG_PULLED`,
//      `EXPIRED_LOT_ASSIGNED`, `LABEL_DAMAGED`, etc.) — a
//      different operator audience (fill tech, not typist) and
//      different compliance vocabulary. Several codes pin
//      specific workflow-safety rules:
//      `EXPIRED_LOT_ASSIGNED` and `HELD_LOT_ASSIGNED` are the
//      "No expired lot assignment" and "No held lot assignment"
//      rules respectively, and `LABEL_DAMAGED` covers "No silent
//      printer failures" reaching the vial. The cross-registry
//      input guard (rejecting a PV1 code like `DOSE_INCORRECT`
//      sent to a FINAL rejection) is enforced at the Zod
//      boundary as `COMMAND_INPUT_INVALID`.
//
// Writes a `verification_record` row with `{stage: FINAL,
// decision: REJECTED, rejectionReasonCode}` — completes the
// `(stage, decision)` matrix in the table:
//   (PV1, APPROVED), (PV1, REJECTED), (FINAL, APPROVED), (FINAL, REJECTED).
// FINAL-stage error codes REUSED from `start-final-verification.js`.
export {
  RejectFinalVerification,
  type RejectFinalVerificationInput,
  type RejectFinalVerificationOutput,
} from "./commands/reject-final-verification.js";

// MarkTypingMissingInfo + ResumeTyping form the typing-stage
// exception loop: a typist pauses on a blocker (prescriber
// callback, illegible Rx, missing field, etc.), the order parks
// in TYPING_PENDING_MISSING_INFO on the TYPING bucket, and any
// typist resumes when the info comes back. Reuses the typing-
// stage error vocabulary from `start-typing.js`. The reasons
// enum lives in `missing-info-reasons.js` (closed list, queryable
// for ops reports).
export {
  MarkTypingMissingInfo,
  type MarkTypingMissingInfoInput,
  type MarkTypingMissingInfoOutput,
} from "./commands/mark-typing-missing-info.js";

export {
  ResumeTyping,
  type ResumeTypingInput,
  type ResumeTypingOutput,
} from "./commands/resume-typing.js";

export {
  MISSING_INFO_REASONS,
  MISSING_INFO_REASONS_SET,
  isMissingInfoReason,
  type MissingInfoReason,
} from "./missing-info-reasons.js";

import * as approveFinalVerificationModule from "./commands/approve-final-verification.js";
import * as approvePV1Module from "./commands/approve-pv1.js";
import * as completeTypingReviewModule from "./commands/complete-typing-review.js";
import * as markTypingMissingInfoModule from "./commands/mark-typing-missing-info.js";
import * as rejectFinalVerificationModule from "./commands/reject-final-verification.js";
import * as rejectPV1Module from "./commands/reject-pv1.js";
import * as resumeTypingModule from "./commands/resume-typing.js";
import * as startFinalVerificationModule from "./commands/start-final-verification.js";
import * as startPV1Module from "./commands/start-pv1.js";
import * as startTypingModule from "./commands/start-typing.js";

export const verification = {
  commands: {
    StartTyping: startTypingModule.StartTyping,
    CompleteTypingReview: completeTypingReviewModule.CompleteTypingReview,
    MarkTypingMissingInfo: markTypingMissingInfoModule.MarkTypingMissingInfo,
    ResumeTyping: resumeTypingModule.ResumeTyping,
    StartPV1: startPV1Module.StartPV1,
    ApprovePV1: approvePV1Module.ApprovePV1,
    RejectPV1: rejectPV1Module.RejectPV1,
    StartFinalVerification: startFinalVerificationModule.StartFinalVerification,
    ApproveFinalVerification: approveFinalVerificationModule.ApproveFinalVerification,
    RejectFinalVerification: rejectFinalVerificationModule.RejectFinalVerification,
  },
} as const;
