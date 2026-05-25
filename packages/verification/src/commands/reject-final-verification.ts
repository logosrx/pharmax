// RejectFinalVerification — the second pharmacist refuses to release
// the FILLED vial and bounces the order back to FILL for rework.
//
// Why this is a DIFFERENT shape from ApproveFinalVerification (read
// this before editing):
//
//   ApproveFinalVerification declares `sodRules`; RejectFinalVerification
//   deliberately does NOT. The Separation-of-Duties rules
//   `sod.pv1-final-same-actor` and `sod.fill-final-same-actor` (in
//   `@pharmax/rbac/separation-of-duties.ts`) are scoped to
//   `attempted: FINAL_APPROVE`. Neither names `FINAL_REJECT`.
//
//   The asymmetry is identical in spirit to `RejectPV1` — pharmacy
//   two-person check protects against SIGN-OFF by the same person
//   who did the prior step (typing OR fill, in this case),
//   because sign-off after self-work breaks the two-set-of-eyes
//   guarantee. Rejection by the same actor is the OPPOSITE: it is
//   healthy self-correction. The pharmacist who also completed the
//   fill SHOULD be allowed to spot their own error mid-verification
//   and reject the order back into fill. Forbidding self-rejection
//   here would push the actor to "approve anyway and ask someone
//   to fix it later" — exactly the worst outcome the workflow is
//   designed to prevent.
//
//   Therefore RejectFinalVerification has no `sodRules` clause.
//   The factory correctly skips the `orderEvent.findMany` SoD-
//   history load when `sodRules` is empty (verified by the
//   `StartFinalVerification` tests). This avoids a useless full-
//   history scan on every rejection.
//
//   Future maintainer warning: if you add an
//   `attempted: FINAL_REJECT` rule to the SoD registry, you ALSO
//   need to add a `sodRules` clause here. Today there is no such
//   rule.
//
// Why this is a DIFFERENT shape from RejectPV1 (the PV1-stage
// analog):
//
//   The destination bucket is "FILL", not "TYPING". By the time
//   the order reaches FINAL_VERIFICATION_IN_PROGRESS, both typing
//   and PV1 have ALREADY passed — the prescription itself is
//   correct. What failed at final review is the PHYSICAL FILL
//   (wrong drug pulled, wrong strength in the vial, wrong NDC,
//   damaged label, expired lot, etc. — see
//   `FINAL_REJECTION_REASONS`). The work to redo is the fill, not
//   the typing. Routing back to typing would force a typist to
//   re-validate an already-validated prescription; routing back
//   to PV1 would force the PV1 pharmacist to re-approve work they
//   already approved. Neither matches operational reality.
//
//   The reason-code registry is also different: `FINAL_REJECTION_REASONS`
//   describes FILL errors (`WRONG_DRUG_PULLED`,
//   `EXPIRED_LOT_ASSIGNED`, `LABEL_DAMAGED`, etc.) — a different
//   operator audience (fill tech vs. typist) and a different
//   compliance vocabulary (pinning the "No expired lot
//   assignment" and "No held lot assignment" workflow-safety
//   rules).
//
// Inputs (validated by Zod):
//
//   - `orderId` (UUID) — the order to reject.
//   - `reasonCode` — a code from `FINAL_REJECTION_REASONS`. The
//     workflow-safety rule "Every rejection requires a reason
//     code" is enforced HERE (Zod), at the schema level
//     (`verification_record_rejection_reason_required` CHECK
//     constraint), and at the row write (decision: REJECTED →
//     `rejectionReasonCode` MUST be non-null). Triple-belt.
//
// What this handler does inside the bus's tx (post-lock,
// post-policy):
//
//   1. Validate policy version (`order.standard@v1` only). Reuses
//      `FINAL_POLICY_UNSUPPORTED` from `start-final-verification.ts`.
//   2. Validate the `(currentState, REJECT_FINAL_VERIFICATION)`
//      transition via the pure engine. Reuses the FINAL-stage
//      error vocabulary from `start-final-verification.ts`
//      (`FINAL_INVALID_TRANSITION`, `FINAL_ORDER_TERMINAL`,
//      `FINAL_ORDER_STATE_UNKNOWN`).
//   3. Resolve the destination bucket.
//      `FINAL_VERIFICATION_REJECTED` is an EXCEPTION state and is
//      mapped via `BUCKET_CODE_FOR_EXCEPTION_STATE` (NOT
//      `BUCKET_CODE_FOR_STATUS`, which is exhaustive over PRIMARY
//      states only). Today the mapping is
//      `FINAL_VERIFICATION_REJECTED → "FILL"` (bounce back to
//      fill queue); future per-org policy slices may override.
//      Missing bucket → `FILL_BUCKET_NOT_CONFIGURED` (REUSED from
//      `approve-pv1.ts` — same operator remediation as a missing
//      fill bucket at any other point in the workflow).
//   4. **Write the `verification_record` row** (decision:
//      REJECTED, `rejectionReasonCode` non-null, `stage: FINAL`).
//      Constraint-failure ordering: written BEFORE `order.update`
//      so a DB CHECK violation surfaces a record-shaped error
//      rather than an "order updated but no record" inconsistency.
//      Same atomicity (single tx) as every other verification
//      command; the ordering matters for diagnosis only.
//   5. `order.update` — set `currentStatus =
//      FINAL_VERIFICATION_REJECTED`, `currentBucketId =
//      <fill bucket>`, and CLEAR `currentAssigneeUserId` to NULL.
//      The pharmacist is done; the order belongs back in the fill
//      queue as unassigned so any tech can pick it up via the
//      standard fill-start flow (or a future `RestartFill`).
//   6. The factory's `bumpVersion` CAS-bumps `version`.
//
// PHI invariant:
//
//   Input carries `orderId` + `reasonCode` only. The reason code
//   is OPERATIONAL VOCABULARY (`WRONG_DRUG_PULLED`, etc.), not
//   PHI. Audit metadata + outbox payload reference scope (orderId,
//   organizationId, siteId, rejectingPharmacistUserId,
//   bucketIdAfter, verificationRecordId), workflow identity
//   (fromState, toState, transitionId, policyId, policyVersion),
//   and the reason code — zero patient PHI. The free-text
//   "rejection note" (PHI-adjacent) is intentionally DEFERRED to a
//   later slice that adds an encrypted column to
//   `verification_record`.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus, VerificationDecision, VerificationStage } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import {
  applyTransition,
  BUCKET_CODE_FOR_EXCEPTION_STATE,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  isOrderState,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

import { FINAL_REJECTION_REASONS, type FinalRejectionReason } from "../rejection-reasons.js";
import { FILL_BUCKET_NOT_CONFIGURED } from "./approve-pv1.js";
import {
  FINAL_INVALID_TRANSITION,
  FINAL_ORDER_STATE_UNKNOWN,
  FINAL_ORDER_TERMINAL,
  FINAL_POLICY_UNSUPPORTED,
} from "./start-final-verification.js";

// ---------------------------------------------------------------------------
// Input
//
// `reasonCode` is validated against the frozen `FINAL_REJECTION_REASONS`
// list at the Zod boundary — the schema deliberately uses
// `z.enum(FINAL_REJECTION_REASONS)` so an unknown code surfaces as
// `COMMAND_INPUT_INVALID` (the standard validation failure mode)
// rather than as a downstream constraint-violation. Both the DB
// CHECK constraint and the workflow-safety rule remain as
// defense-in-depth, but the user-friendly error happens here.
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    reasonCode: z.enum(FINAL_REJECTION_REASONS),
  })
  .strict();

export type RejectFinalVerificationInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface RejectFinalVerificationOutput {
  readonly orderId: string;
  readonly currentStatus: "FINAL_VERIFICATION_REJECTED";
  readonly version: number;
  readonly transitionId: string;
  readonly verificationRecordId: string;
  readonly reasonCode: FinalRejectionReason;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const RejectFinalVerification = defineCommand<
  RejectFinalVerificationInput,
  RejectFinalVerificationOutput
>({
  name: "RejectFinalVerification",
  inputSchema,
  permission: PERMISSIONS.FINAL_REJECT,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  // INTENTIONALLY EMPTY. See the header comment for why
  // self-rejection is allowed (and why adding `sodRules` here
  // without a corresponding SoD registry rule would only cost a
  // findMany() per rejection without enforcing anything).
  redactFields: [],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "REJECT_FINAL_VERIFICATION_NO_TARGET",
        message: "Locked target was not provided to RejectFinalVerification handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "REJECT_FINAL_VERIFICATION_NO_POLICY",
        message: "Workflow policy was not loaded for RejectFinalVerification.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: FINAL_POLICY_UNSUPPORTED,
        message:
          "RejectFinalVerification handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: FINAL_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "REJECT_FINAL_VERIFICATION",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: FINAL_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: FINAL_INVALID_TRANSITION,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    // Destination bucket: FINAL_VERIFICATION_REJECTED → "FILL"
    // (rework loop back to fill). Sourced from the EXCEPTION-state
    // map, not the primary map. Direct dictionary access (not the
    // `bucketCodeForStatus` helper) so a missing mapping is a
    // TypeScript-narrowable `string | undefined`, not a `null`
    // requiring runtime coercion.
    const reworkBucketCode = BUCKET_CODE_FOR_EXCEPTION_STATE.FINAL_VERIFICATION_REJECTED;
    if (reworkBucketCode === undefined) {
      // Defensive: a future maintainer removed
      // FINAL_VERIFICATION_REJECTED from the exception map
      // without updating this command. Loud failure beats a
      // silent "no bucket update" that would leave the order
      // stuck in the FINAL queue with a REJECTED status.
      throw new errors.InternalError({
        code: "FINAL_VERIFICATION_REJECTED_BUCKET_MAPPING_MISSING",
        message:
          "FINAL_VERIFICATION_REJECTED has no entry in BUCKET_CODE_FOR_EXCEPTION_STATE; " +
          "the exception map and RejectFinalVerification are out of sync.",
      });
    }
    const reworkBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: reworkBucketCode,
      },
      select: { id: true },
    });
    if (reworkBucket === null) {
      throw new errors.InternalError({
        code: FILL_BUCKET_NOT_CONFIGURED,
        message: `No ${reworkBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: reworkBucketCode },
      });
    }

    const rejectingPharmacistUserId = ctx.actor.userId;

    // Write the verification_record row FIRST (before the
    // order.update). Same constraint-failure ordering rationale
    // as ApprovePV1 / RejectPV1 / ApproveFinalVerification — a
    // CHECK-constraint failure surfaces with an obviously-related
    // error message rather than "order updated but no record".
    const verificationRecord = await tx.verificationRecord.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        stage: VerificationStage.FINAL,
        decision: VerificationDecision.REJECTED,
        pharmacistUserId: rejectingPharmacistUserId,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        rejectionReasonCode: input.reasonCode,
        commandLogId,
      },
      select: { id: true },
    });

    // Domain write: state + bucket + ASSIGNEE-CLEAR. The
    // pharmacist is done with this rejection; the order belongs
    // back in the fill queue as unassigned so any tech can pick
    // it up via the standard fill-start flow (or a future
    // `RestartFill`). The historical "rejecting pharmacist"
    // identity is preserved on the `verification_record` row, on
    // the `order_event` row's `actorUserId` column, and on
    // `audit_log.metadata.rejectingPharmacistUserId`.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.FINAL_VERIFICATION_REJECTED,
        currentBucketId: reworkBucket.id,
        currentAssigneeUserId: null,
      },
    });

    const now = clock.now();

    return {
      output: {
        orderId: target.id,
        currentStatus: "FINAL_VERIFICATION_REJECTED" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
        verificationRecordId: verificationRecord.id,
        reasonCode: input.reasonCode,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.final.rejected",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          fromState: transition.fromState,
          toState: transition.toState,
          transitionId: transition.transitionId,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          siteId: target.siteId,
          bucketIdAfter: reworkBucket.id,
          rejectingPharmacistUserId,
          reasonCode: input.reasonCode,
          verificationRecordId: verificationRecord.id,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.final.rejected.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            rejectingPharmacistUserId,
            bucketId: reworkBucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            reasonCode: input.reasonCode,
            verificationRecordId: verificationRecord.id,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
