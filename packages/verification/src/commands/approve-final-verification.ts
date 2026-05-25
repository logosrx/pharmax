// ApproveFinalVerification — the second pharmacist signs off on
// the filled vial and releases the order to the SHIPPING queue.
// THIS IS THE LAST SAFETY GATE BEFORE A DRUG LEAVES THE BUILDING.
//
// Why this command is the most consequential one shipped so far:
//
//   It is the FINAL CHECK in the two-pharmacist verification
//   safety net. A bad approval here puts the wrong drug (or
//   wrong dose, wrong patient, wrong instructions) into a
//   carrier's hands. The SoD rules below are not "best practice"
//   — they are the regulatory + clinical rationale for why
//   pharmacies exist as a profession at all.
//
//   Three intentional "firsts" in the codebase land here:
//
//     1. **FIRST MULTI-RULE SoD COMMAND.** The rbac registry has
//        TWO rules whose `attempted` is `FINAL_APPROVE`:
//          - `sod.pv1-final-same-actor`: forbids prior
//            `PV1_APPROVE` by the same actor on the same order.
//          - `sod.fill-final-same-actor`: forbids prior
//            `FILL_COMPLETE` by the same actor on the same order.
//        Both rules MUST fire when their precondition is met.
//        The bus's `requireNoSoDViolation` walks every registry
//        rule matching `attempted`, so a SINGLE `sodRules` entry
//        with `attempted: FINAL_APPROVE` exercises BOTH rules
//        against the loaded history — no need to declare two
//        clauses (which would only cost a second `findMany`).
//        This is the multi-rule fan-out pattern.
//
//     2. **FIRST FINAL-stage `verification_record` writer.** The
//        `(stage: FINAL, decision: APPROVED, reasonCode: null)`
//        row is the structured-record half of the safety
//        promise; the audit row + order event are the
//        forensic-record half. All three commit together inside
//        the tx; a partial failure rolls everything back. Same
//        constraint-failure ordering as `ApprovePV1` —
//        `verification_record.create` happens BEFORE
//        `order.update` so a DB CHECK violation surfaces a
//        record-shaped error rather than an "order updated but
//        no record" inconsistency.
//
//     3. **FIRST writer of a SHIPPING-bucket transition.**
//        Destination state `FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP`
//        maps to `"SHIPPING"` via `BUCKET_CODE_FOR_STATUS`.
//        Missing bucket → NEW code `SHIPPING_BUCKET_NOT_CONFIGURED`
//        (will be REUSED by `ReleaseToShip`, `ConfirmShipment`
//        when those land).
//
// What this handler does inside the bus's tx (post-lock,
// post-policy, post-SoD):
//
//   1. Reject if the loaded policy isn't `order.standard@v1`
//      (replay-correctness guarantee — uses the FINAL-stage
//      `FINAL_POLICY_UNSUPPORTED` code REUSED from
//      `start-final-verification.js`).
//   2. Validate the (currentState, APPROVE_FINAL_VERIFICATION)
//      transition via the pure engine. Result codes map to the
//      FINAL-stage error vocabulary, also REUSED from
//      `start-final-verification.js`.
//   3. Resolve the SHIPPING bucket from `target.siteId` and the
//      canonical bucket code for
//      `FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP`. Missing
//      bucket → `SHIPPING_BUCKET_NOT_CONFIGURED` (new code).
//   4. Write the `verification_record` row first (constraint-
//      ordering, see above): `{stage: FINAL, decision: APPROVED,
//      rejectionReasonCode: null, ...}`. The `null` reason is
//      REQUIRED by the DB CHECK constraint for APPROVED rows.
//   5. `order.update` — `currentStatus =
//      FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP`,
//      `currentBucketId = <shipping bucket>`, and CLEAR
//      `currentAssigneeUserId` to NULL. The pharmacist is done;
//      the order belongs in the SHIPPING queue as unassigned
//      so any shipping clerk can claim it via `ReleaseToShip`.
//      The historical "approving pharmacist" identity is
//      preserved on the `verification_record.pharmacistUserId`
//      column, on the `order_event.actorUserId` column, and on
//      `audit_log.metadata.approvingPharmacistUserId`. Symmetric
//      to ApprovePV1's assignee-clear.
//   6. The factory's `bumpVersion` CAS-bumps `version`.
//
// Operational consequence (worth pinning in code, not just docs):
//
//   The order is now eligible for label generation, manifesting,
//   and carrier handoff. Any cancellation past this point goes
//   through the standard CancelOrder command but ALSO requires
//   a "recall" subflow (not yet implemented) — once the carrier
//   accepts the package, the pharmacy has lost direct custody.
//   This handler does NOT trigger label generation directly;
//   the outbox event `order.final.approved.v1` is the trigger.
//   A downstream worker subscribes, validates that an Rx label
//   record exists (created at the fill stage), and queues the
//   shipping-label generation job. Separation of concerns:
//   workflow state lives in the bus, side effects live in
//   workers. The audit chain links the two via correlationId.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox
//   payload reference scope (orderId, organizationId, siteId,
//   approvingPharmacistUserId, bucketIdAfter,
//   verificationRecordId) and workflow identity (fromState,
//   toState, transitionId, policyId, policyVersion) — zero
//   patient PHI. The downstream label-generation worker is
//   responsible for fetching the PHI it needs from the order
//   aggregate via its own scoped read, not from this payload.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus, VerificationDecision, VerificationStage } from "@pharmax/database";
import { orderEventTypeToPermission } from "@pharmax/orders";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { applyCommandStageIntervalTransition } from "@pharmax/sla";
import {
  applyTransition,
  BUCKET_CODE_FOR_STATUS,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  isOrderState,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

import {
  FINAL_INVALID_TRANSITION,
  FINAL_ORDER_STATE_UNKNOWN,
  FINAL_ORDER_TERMINAL,
  FINAL_POLICY_UNSUPPORTED,
} from "./start-final-verification.js";

// ---------------------------------------------------------------------------
// Error codes
//
// FINAL-stage failure codes REUSED from `start-final-verification.js`
// (one stable code per failure class per stage — same convention as
// the typing and PV1 stages). The destination-bucket-missing code
// is NEW here because no command has resolved the SHIPPING bucket
// before; it will be SHARED with `ReleaseToShip` (which keeps the
// order in the SHIPPING bucket as it moves to `READY_TO_SHIP`)
// and `ConfirmShipment` (which keeps it there until terminal
// `SHIPPED`) — same operator remediation regardless of which
// command surfaces it.
// ---------------------------------------------------------------------------

export const SHIPPING_BUCKET_NOT_CONFIGURED = "SHIPPING_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type ApproveFinalVerificationInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ApproveFinalVerificationOutput {
  readonly orderId: string;
  readonly currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP";
  readonly version: number;
  readonly transitionId: string;
  readonly verificationRecordId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const ApproveFinalVerification = defineCommand<
  ApproveFinalVerificationInput,
  ApproveFinalVerificationOutput
>({
  name: "ApproveFinalVerification",
  inputSchema,
  permission: PERMISSIONS.FINAL_APPROVE,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  // SINGLE entry. The rbac registry contains TWO rules with
  // `attempted: FINAL_APPROVE` (`sod.pv1-final-same-actor` and
  // `sod.fill-final-same-actor`); `requireNoSoDViolation` walks
  // ALL of them against the loaded history in one pass.
  // Declaring two separate `sodRules` entries here would
  // duplicate the `orderEvent.findMany` load with no enforcement
  // gain — the bus's `for` loop calls `requireNoSoDViolationForOrder`
  // once per entry, and that helper loads history independently.
  // The multi-rule fan-out lives in the registry, by design.
  sodRules: [
    {
      attempted: PERMISSIONS.FINAL_APPROVE,
      against: "target",
      translate: orderEventTypeToPermission,
    },
  ],
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "APPROVE_FINAL_VERIFICATION_NO_TARGET",
        message: "Locked target was not provided to ApproveFinalVerification handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "APPROVE_FINAL_VERIFICATION_NO_POLICY",
        message: "Workflow policy was not loaded for ApproveFinalVerification.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: FINAL_POLICY_UNSUPPORTED,
        message:
          "ApproveFinalVerification handler is wired only for order.standard v1. " +
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
      command: "APPROVE_FINAL_VERIFICATION",
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

    // Destination bucket: FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP
    // → "SHIPPING" (first command in the codebase to resolve the
    // SHIPPING bucket).
    const shippingBucketCode = BUCKET_CODE_FOR_STATUS.FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP;
    const shippingBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: shippingBucketCode,
      },
      select: { id: true },
    });
    if (shippingBucket === null) {
      throw new errors.InternalError({
        code: SHIPPING_BUCKET_NOT_CONFIGURED,
        message: `No ${shippingBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: shippingBucketCode },
      });
    }

    const approvingPharmacistUserId = ctx.actor.userId;

    // Write verification_record FIRST (constraint-failure
    // ordering — same rationale as ApprovePV1 + RejectPV1). For
    // APPROVED rows the DB CHECK constraint REQUIRES
    // `rejectionReasonCode` to be null; a non-null value would
    // fail INSERT-time and roll back the whole tx.
    const verificationRecord = await tx.verificationRecord.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        stage: VerificationStage.FINAL,
        decision: VerificationDecision.APPROVED,
        pharmacistUserId: approvingPharmacistUserId,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        rejectionReasonCode: null,
        commandLogId,
      },
      select: { id: true },
    });

    // Domain write: state + bucket + ASSIGNEE-CLEAR. The
    // pharmacist is done; the order belongs in the SHIPPING
    // queue as unassigned so any shipping clerk can claim it via
    // `ReleaseToShip`. Historical identity preserved on the
    // verification_record, the order_event, and the audit_log.
    // Symmetric to ApprovePV1.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP,
        currentBucketId: shippingBucket.id,
        currentAssigneeUserId: null,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "ApproveFinalVerification",
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      at: now,
      commandLogId,
      actorUserId: ctx.actor.userId,
    });

    return {
      output: {
        orderId: target.id,
        currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
        verificationRecordId: verificationRecord.id,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.final.approved",
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
          bucketIdAfter: shippingBucket.id,
          approvingPharmacistUserId,
          verificationRecordId: verificationRecord.id,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.final.approved.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            approvingPharmacistUserId,
            bucketId: shippingBucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            verificationRecordId: verificationRecord.id,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
