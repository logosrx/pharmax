// RejectPV1 — the PV1 pharmacist refuses to sign off on the typed
// prescription and bounces the order back to typing for correction.
//
// Why this is a DIFFERENT shape from ApprovePV1 (read this before
// editing):
//
//   ApprovePV1 declares `sodRules`; RejectPV1 deliberately does
//   NOT. The Separation-of-Duties rule
//   `sod.typing-pv1-same-actor` (in
//   `@pharmax/rbac/separation-of-duties.ts`) is scoped to
//   `attempted: PV1_APPROVE`. It does NOT name `PV1_REJECT`.
//
//   That asymmetry is intentional, not an oversight. Pharmacy
//   two-person check protects against SIGN-OFF by the same person
//   who entered the data — the typist signing off on their own
//   typing breaks the two-set-of-eyes guarantee. Rejection by the
//   same actor is the OPPOSITE: it is healthy self-correction.
//   The typist who realises mid-review "wait, I typed this wrong"
//   SHOULD be able to reject it back into typing so they can fix
//   it. Forbidding self-rejection would push the actor to "approve
//   anyway and ask someone to fix it later" — a worse outcome.
//
//   Therefore RejectPV1 has no `sodRules` clause. The factory
//   correctly skips the `orderEvent.findMany` SoD-history load
//   when `sodRules` is empty (verified by the StartPV1 tests).
//   This avoids a useless full-history scan on every rejection.
//
//   Future maintainer warning: if you add an `attempted:
//   PV1_REJECT` rule to the SoD registry, you ALSO need to add a
//   `sodRules` clause here. Today there is no such rule.
//
// Inputs (validated by Zod):
//
//   - `orderId` (UUID) — the order to reject.
//   - `reasonCode` — a code from `PV1_REJECTION_REASONS`. The
//     workflow-safety rule "Every rejection requires a reason
//     code" is enforced HERE (Zod), at the schema level
//     (`verification_record_rejection_reason_required` CHECK
//     constraint), and at the row write (decision: REJECTED →
//     `rejectionReasonCode` MUST be non-null). Triple-belt.
//
// What this handler does inside the bus's tx (post-lock,
// post-policy):
//
//   1. Validate policy version (`order.standard@v1` only). Same
//      replay-correctness guard as every other state-transition
//      command in this codebase. Reuses `PV1_POLICY_UNSUPPORTED`
//      from `start-pv1.ts`.
//   2. Validate the `(currentState, REJECT_PV1)` transition via
//      the pure engine. Reuses the PV1-stage error vocabulary
//      from `start-pv1.ts` (`PV1_INVALID_TRANSITION`,
//      `PV1_ORDER_TERMINAL`, `PV1_ORDER_STATE_UNKNOWN`).
//   3. Resolve the destination bucket. `PV1_REJECTED` is an
//      EXCEPTION state and is mapped via
//      `BUCKET_CODE_FOR_EXCEPTION_STATE` (NOT
//      `BUCKET_CODE_FOR_STATUS`, which is exhaustive over PRIMARY
//      states only). Today the mapping is `PV1_REJECTED →
//      "TYPING"` (bounce back to typing queue); future per-org
//      policy slices may override. Missing bucket →
//      `TYPING_BUCKET_NOT_CONFIGURED` (REUSED from
//      `start-typing.ts` — same operator remediation as a missing
//      typing bucket at any other point in the workflow).
//   4. **Write the `verification_record` row** (decision:
//      REJECTED, `rejectionReasonCode` non-null). This is the
//      FIRST production command in the codebase that writes a
//      verification record — it pairs with the ApprovePV1
//      amendment in this same slice. The row is INSERT-ONLY
//      (RLS denies UPDATE/DELETE; the GRANT layer additionally
//      revokes them). One row per command invocation; multiple
//      rows per (orderId, stage) are expected across rework loops.
//   5. `order.update` — set `currentStatus = PV1_REJECTED`,
//      `currentBucketId = <typing bucket>`, and CLEAR
//      `currentAssigneeUserId` to NULL. The pharmacist is done;
//      the order belongs in the typing queue as unassigned so
//      any typist can pick it up via `ReopenForCorrection` (or
//      a future `MarkTypingRework`).
//   6. The factory's `bumpVersion` CAS-bumps `version`.
//
// PHI invariant:
//
//   Input carries `orderId` + `reasonCode` only. The reason code
//   is OPERATIONAL VOCABULARY (`DOSE_INCORRECT`, etc.), not PHI.
//   Audit metadata + outbox payload reference scope (orderId,
//   organizationId, siteId, rejectingPharmacistUserId,
//   bucketIdAfter), workflow identity (fromState, toState,
//   transitionId, policyId, policyVersion), and the reason code
//   — zero patient PHI. The free-text "rejection note" (PHI-
//   adjacent) is intentionally DEFERRED to a later slice that
//   adds an encrypted column to `verification_record`.

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

import { PV1_REJECTION_REASONS, type PV1RejectionReason } from "../rejection-reasons.js";
import {
  PV1_INVALID_TRANSITION,
  PV1_ORDER_STATE_UNKNOWN,
  PV1_ORDER_TERMINAL,
  PV1_POLICY_UNSUPPORTED,
} from "./start-pv1.js";
import { TYPING_BUCKET_NOT_CONFIGURED } from "./start-typing.js";

// ---------------------------------------------------------------------------
// Input
//
// `reasonCode` is validated against the frozen `PV1_REJECTION_REASONS`
// list at the Zod boundary — the schema deliberately uses
// `z.enum(PV1_REJECTION_REASONS)` so an unknown code surfaces as
// `COMMAND_INPUT_INVALID` (the standard validation failure mode)
// rather than as a downstream constraint-violation. Both the DB
// CHECK constraint and the workflow-safety rule remain as
// defense-in-depth, but the user-friendly error happens here.
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    reasonCode: z.enum(PV1_REJECTION_REASONS),
  })
  .strict();

export type RejectPV1Input = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface RejectPV1Output {
  readonly orderId: string;
  readonly currentStatus: "PV1_REJECTED";
  readonly version: number;
  readonly transitionId: string;
  readonly verificationRecordId: string;
  readonly reasonCode: PV1RejectionReason;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const RejectPV1 = defineCommand<RejectPV1Input, RejectPV1Output>({
  name: "RejectPV1",
  inputSchema,
  permission: PERMISSIONS.PV1_REJECT,
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
        code: "REJECT_PV1_NO_TARGET",
        message: "Locked target was not provided to RejectPV1 handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "REJECT_PV1_NO_POLICY",
        message: "Workflow policy was not loaded for RejectPV1.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: PV1_POLICY_UNSUPPORTED,
        message:
          "RejectPV1 handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: PV1_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "REJECT_PV1",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: PV1_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: PV1_INVALID_TRANSITION,
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

    // Destination bucket: PV1_REJECTED → "TYPING" (rework loop).
    // Sourced from the EXCEPTION-state map, not the primary map,
    // because PV1_REJECTED is an exception state. The lookup is a
    // direct dictionary access (not the `bucketCodeForStatus`
    // helper) so a missing mapping is a TypeScript-narrowable
    // `string | undefined`, not a `null` requiring runtime coercion.
    const reworkBucketCode = BUCKET_CODE_FOR_EXCEPTION_STATE.PV1_REJECTED;
    if (reworkBucketCode === undefined) {
      // Defensive: a future maintainer removed PV1_REJECTED from
      // the exception map without updating this command. Loud
      // failure beats a silent "no bucket update" that would leave
      // the order stuck in the PV1 queue with a REJECTED status.
      throw new errors.InternalError({
        code: "PV1_REJECTED_BUCKET_MAPPING_MISSING",
        message:
          "PV1_REJECTED has no entry in BUCKET_CODE_FOR_EXCEPTION_STATE; " +
          "the exception map and RejectPV1 are out of sync.",
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
        code: TYPING_BUCKET_NOT_CONFIGURED,
        message: `No ${reworkBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: reworkBucketCode },
      });
    }

    const rejectingPharmacistUserId = ctx.actor.userId;

    // Write the verification_record row FIRST (before the
    // order.update), so a downstream constraint violation on the
    // verification record rolls everything back. Order is
    // semantically irrelevant inside a tx (both writes either
    // commit or roll back atomically), but writing the record
    // first surfaces CHECK-constraint failures with an obviously-
    // related error message rather than "order updated but no
    // record".
    const verificationRecord = await tx.verificationRecord.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        stage: VerificationStage.PV1,
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
    // back in the typing queue as unassigned so any typist can
    // pick it up via `ReopenForCorrection` (or a future
    // `MarkTypingRework`). The historical "rejecting pharmacist"
    // identity is preserved on the `verification_record` row, on
    // the `order_event` row's `actorUserId` column, and on
    // `audit_log.metadata.rejectingPharmacistUserId`.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.PV1_REJECTED,
        currentBucketId: reworkBucket.id,
        currentAssigneeUserId: null,
      },
    });

    const now = clock.now();

    return {
      output: {
        orderId: target.id,
        currentStatus: "PV1_REJECTED" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
        verificationRecordId: verificationRecord.id,
        reasonCode: input.reasonCode,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.pv1.rejected",
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
          eventType: "order.pv1.rejected.v1",
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

// Re-export the bus's CAS error code for self-contained callers.
export { ORDER_VERSION_MISMATCH };
