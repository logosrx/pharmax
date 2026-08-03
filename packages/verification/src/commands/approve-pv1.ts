// ApprovePV1 — the pharmacist signs off on the typed prescription
// and releases the order to the FILL queue.
//
// Why this command is a meaningful "first" in the codebase:
//
//   It is the FIRST PRODUCTION COMMAND THAT DECLARES `sodRules`.
//   Every command shipped before this one (CreateOrder,
//   AddPrescription, StartTyping, CompleteTypingReview, StartPV1,
//   plus the externally-scaffolded CancelOrder) either had no SoD
//   constraint or deferred SoD enforcement to a downstream
//   command. ApprovePV1 is the FIRST runtime exercise of the bus's
//   `requireNoSoDViolationForOrder` path against real
//   `order_event` history, using `orderEventTypeToPermission` as
//   the translator.
//
//   What that means at runtime: after the factory locks the order
//   row and loads the policy, but BEFORE this handler's `exec`
//   runs, the factory loads the full `order_event` history for
//   this order, projects each row through
//   `orderEventTypeToPermission`, and calls `requireNoSoDViolation`.
//   The relevant SoD rule (registered in
//   `@pharmax/rbac/separation-of-duties.ts`):
//
//     sod.typing-pv1-same-actor: attempted PV1_APPROVE forbids
//     prior TYPING_COMPLETE by the same actor.
//
//   So if the actor who completed typing on THIS order tries to
//   approve PV1 on the SAME order, the bus raises
//   `AuthorizationError(SOD_VIOLATION)` BEFORE the handler ever
//   runs. The tx rolls back; no state mutates; the audit trail
//   reflects the attempt via `command_log` (status FAILED,
//   error code SOD_VIOLATION). Pharmacy SoD invariant satisfied.
//
//   The `order.typing.completed.v1` event we wired into
//   `ORDER_EVENT_TYPE_TO_PERMISSION` when `CompleteTypingReview`
//   shipped is exactly what makes this enforcement work — the
//   translator returns `PERMISSIONS.TYPING_COMPLETE` for that
//   event, which is what the SoD rule's `forbiddenPriorActs`
//   array references. The wiring is now end-to-end.
//
// What this handler does inside the bus's tx (post-lock, post-policy,
// post-SoD):
//
//   1. Reject if the loaded policy isn't `order.standard@v1` (same
//      replay-correctness guarantee as every state-transition
//      command in this codebase).
//   2. Validate the (currentState, APPROVE_PV1) transition via the
//      pure engine. Result codes map to the PV1-stage error
//      vocabulary defined on `start-pv1.ts` — imported and REUSED
//      here so callers see one stable code per failure class
//      regardless of which PV1-stage command surfaced it (same
//      pattern as CompleteTypingReview reusing the typing-stage
//      codes from start-typing.js).
//   3. Resolve the FILL bucket from `target.siteId` and the
//      canonical bucket code for `PV1_APPROVED_READY_FOR_FILL` via
//      the shared `BUCKET_CODE_FOR_STATUS` map. Missing bucket →
//      `FILL_BUCKET_NOT_CONFIGURED` (new code; will be REUSED by
//      `StartFill` when it ships, same reuse pattern as
//      `PV1_BUCKET_NOT_CONFIGURED`).
//   4. `order.update` — set `currentStatus =
//      PV1_APPROVED_READY_FOR_FILL`, `currentBucketId = <fill
//      bucket>`, and CLEAR `currentAssigneeUserId` to NULL. The
//      pharmacist is done; the order belongs in the FILL queue as
//      unassigned so any tech can claim it via `StartFill`. The
//      historical "approving pharmacist" identity is preserved on
//      the `order_event` row's `actorUserId` column. Symmetric to
//      `CompleteTypingReview`'s assignee-clear.
//   5. The factory's `bumpVersion` CAS-bumps `version` in a
//      separate updateMany.
//
// Verification record table:
//
//   This command writes a `verification_record` row with
//   `decision: APPROVED` and `rejectionReasonCode: null` (the DB
//   CHECK constraint `verification_record_rejection_reason_required`
//   enforces "APPROVED rows MUST have null reasonCode; REJECTED
//   rows MUST have non-null reasonCode" — see the migration
//   comment at
//   `20260525000000_phase2_verification_record/migration.sql`,
//   block 4).
//
//   This write was added IN LOCKSTEP with `RejectPV1` landing in
//   the same slice. The report indexes
//   `(organizationId, stage, decision, occurredAt)` and
//   `(organizationId, pharmacistUserId, occurredAt)` were
//   designed to be served from a stream of rows where BOTH
//   decisions are present — writing only on rejection would skew
//   "PV1 approval rate" reports to 0%. Either both commands
//   write, or neither does; the schema's intent is "both write"
//   (per the migration's "FIRST table written by a workflow
//   command alongside a state transition" comment).
//
//   The verification record is INSERT-ONLY by RLS + GRANT +
//   REVOKE (defense in depth — see migration block 6). Once
//   inserted, the row is part of the audit trail forever; future
//   re-approval after a rejection appends a NEW row rather than
//   updating this one (the workflow engine prevents an order from
//   re-entering `PV1_APPROVED_READY_FOR_FILL` while it already
//   sits there, so the natural multiplicity is one row per
//   command invocation across rework loops).
//
// Clinical-screening gate:
//
//   This command RE-SCREENS rather than trusting the snapshot
//   StartPV1 took, and refuses the approval on two conditions, with
//   two distinct error codes so the console can explain them
//   differently:
//
//     - `PV1_SCREENING_HARD_STOP` — a finding whose disposition is
//       HARD_STOP. No override path exists; the pharmacist's next
//       move is the prescriber, not a dismiss button.
//     - `PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED` — a finding
//       requiring acknowledgement that THIS pharmacist has not
//       acknowledged. Not "any pharmacist": an acknowledgement is a
//       professional judgement attached to a person, and inheriting a
//       colleague's is how it degrades into a checkbox.
//
//   Both are `InvariantViolationError` (422): the request is
//   well-formed, the actor is authorized, and a business rule refused
//   the act. Since PR #77 the v1 API derives HTTP status from the
//   error class, so the class choice IS the partner-facing contract —
//   `ConflictError` (409) would tell an integrator to retry, which
//   would be wrong for both of these.
//
//   Why re-screen at all, given StartPV1 already did: a PV1 review is
//   not instantaneous. See the long comment at the call site.
//
// SLA interval invariant:
//
//   Same as every state-transition command shipped so far — no
//   `order_stage_interval` row is written here. Phase 3 will
//   retrofit every command in lockstep to close `PV1_ACTIVE` and
//   open `WAIT_BEFORE_FILL`.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox payload
//   reference scope (orderId, organizationId, siteId,
//   approvingPharmacistUserId, bucketIdAfter) and workflow
//   identity (fromState, toState, transitionId, policyId,
//   policyVersion) — zero patient PHI.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import {
  OrderStatus,
  ScreeningPhase,
  VerificationDecision,
  VerificationStage,
} from "@pharmax/database";
import { orderEventTypeToPermission } from "@pharmax/order-contracts";
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

import { assertScreeningPermitsApproval } from "../screening/gate.js";
import { loadPatientIdForOrder } from "../screening/order-patient.js";
import { projectScreening } from "../screening/projection.js";
import { persistFindings, runOrderScreen } from "../screening/run-screen.js";

import {
  PV1_INVALID_TRANSITION,
  PV1_ORDER_STATE_UNKNOWN,
  PV1_ORDER_TERMINAL,
  PV1_POLICY_UNSUPPORTED,
} from "./start-pv1.js";

// ---------------------------------------------------------------------------
// Error codes
//
// PV1-stage failure codes are imported from `start-pv1.ts` (one
// stable code per failure class per stage, same convention the
// typing stage uses). The destination-bucket-missing code is NEW
// here because no command has resolved the FILL bucket before; it
// will be SHARED with `StartFill` when that ships.
// ---------------------------------------------------------------------------

export const FILL_BUCKET_NOT_CONFIGURED = "FILL_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type ApprovePV1Input = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ApprovePV1Output {
  readonly orderId: string;
  readonly currentStatus: "PV1_APPROVED_READY_FOR_FILL";
  readonly version: number;
  readonly transitionId: string;
  readonly verificationRecordId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const ApprovePV1 = defineCommand<ApprovePV1Input, ApprovePV1Output>({
  name: "ApprovePV1",
  inputSchema,
  permission: PERMISSIONS.PV1_APPROVE,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  // The load-bearing new thing in this slice. The bus's factory
  // invokes `requireNoSoDViolationForOrder` for each entry between
  // policy-load and handler-exec; the helper loads
  // `tx.orderEvent.findMany({ where: { orderId } })` (sequenceNumber
  // ASC), projects each event through `orderEventTypeToPermission`,
  // and fails closed on any matching forbidden-prior-act by the
  // same actor. Specifically: the registry's
  // `sod.typing-pv1-same-actor` rule will fire if the actor about
  // to call ApprovePV1 was the same actor who emitted
  // `order.typing.completed.v1` (translated to TYPING_COMPLETE) on
  // this order.
  sodRules: [
    {
      attempted: PERMISSIONS.PV1_APPROVE,
      against: "target",
      translate: orderEventTypeToPermission,
    },
  ],
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "APPROVE_PV1_NO_TARGET",
        message: "Locked target was not provided to ApprovePV1 handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "APPROVE_PV1_NO_POLICY",
        message: "Workflow policy was not loaded for ApprovePV1.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: PV1_POLICY_UNSUPPORTED,
        message:
          "ApprovePV1 handler is wired only for order.standard v1. " +
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
      // Merged per-tenant overlay snapshot when resolved (ADR-0019);
      // static base otherwise. Overlays can FORBID or tighten this
      // transition — evaluating the base here would silently bypass
      // tenant compliance policy.
      policy: policy.merged?.merged ?? ORDER_STANDARD_V1,
      currentState,
      command: "APPROVE_PV1",
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

    const approvingPharmacistUserId = ctx.actor.userId;

    // ---------------------------------------------------------------
    // Clinical screening — RE-SCREENED HERE, not read from StartPV1.
    //
    // StartPV1 already wrote a set of findings. They are not what this
    // command gates on, and the difference is the point of the whole
    // feature. A PV1 review takes minutes to hours: in that window a
    // clinic can add a medication to the patient's profile, another
    // prescription can be transcribed onto the order, or this one can
    // be edited. Gating on the snapshot taken when the pharmacist
    // OPENED the review means signing off against a world that may no
    // longer exist, and the interval between the two is exactly where
    // a new interaction appears.
    //
    // So the screen runs again, the gate uses this result, and this
    // result is what gets persisted as the record of what the
    // approval was actually made against. The PV1_START rows stay
    // where they are — the pair is what makes a mid-review change
    // visible afterwards.
    //
    // Cost is one extra pass of a pure function plus two indexed
    // reads, inside a transaction that is already holding the order's
    // row lock. That is not a price worth trading a stale safety
    // check for.
    //
    // A REFUSED approval persists NO findings: the gate throws, the
    // transaction rolls back, and the evidence of the refusal is the
    // `command_log` row the bus writes outside the tx (status FAILED,
    // errorCode PV1_SCREENING_HARD_STOP or
    // PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED).
    // ---------------------------------------------------------------
    const screeningPolicy = (policy.merged?.merged ?? ORDER_STANDARD_V1).screening;
    const patientId = await loadPatientIdForOrder({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
    });
    const screen = await runOrderScreen({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      patientId,
      policy: screeningPolicy,
    });

    await assertScreeningPermitsApproval({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      pharmacistUserId: approvingPharmacistUserId,
      evaluation: screen.evaluation,
    });

    // Destination bucket: PV1_APPROVED_READY_FOR_FILL → "FILL"
    // (first command in the codebase to resolve the FILL bucket).
    const fillBucketCode = BUCKET_CODE_FOR_STATUS.PV1_APPROVED_READY_FOR_FILL;
    const fillBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: fillBucketCode,
      },
      select: { id: true },
    });
    if (fillBucket === null) {
      throw new errors.InternalError({
        code: FILL_BUCKET_NOT_CONFIGURED,
        message: `No ${fillBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: fillBucketCode },
      });
    }

    // Write the verification_record row FIRST (before the
    // order.update). Same ordering rationale as `RejectPV1`:
    // both writes commit-or-roll-back atomically inside the
    // tx, but writing the record first surfaces CHECK-
    // constraint failures with an obviously-related error
    // message rather than "order updated but no record".
    //
    // `rejectionReasonCode: null` is REQUIRED by the DB CHECK
    // constraint when `decision = APPROVED`. Sending a non-null
    // reason here would fail at INSERT time.
    const verificationRecord = await tx.verificationRecord.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        stage: VerificationStage.PV1,
        decision: VerificationDecision.APPROVED,
        pharmacistUserId: approvingPharmacistUserId,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        rejectionReasonCode: null,
        commandLogId,
      },
      select: { id: true },
    });

    // Domain write: state + bucket + ASSIGNEE-CLEAR. The pharmacist
    // is done; the order belongs in the FILL queue as unassigned
    // so any tech can claim it via `StartFill`. The historical
    // "approving pharmacist" identity is preserved on the
    // `verification_record` row, on the `order_event` row's
    // `actorUserId` column, and on
    // `audit_log.metadata.approvingPharmacistUserId`. Symmetric
    // to CompleteTypingReview's assignee-clear.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.PV1_APPROVED_READY_FOR_FILL,
        currentBucketId: fillBucket.id,
        currentAssigneeUserId: null,
      },
    });

    const now = clock.now();

    // The record of what this approval was screened against. Written
    // after the gate passed, so every PV1_APPROVE row in this table
    // belongs to an approval that actually happened.
    await persistFindings({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      phase: ScreeningPhase.PV1_APPROVE,
      screenedForUserId: approvingPharmacistUserId,
      findings: screen.evaluation.findings,
      workflowPolicyId: policy.id,
      workflowPolicyVersion: policy.version,
      minimumReportedSeverity: screeningPolicy.minimumReportedSeverity,
      commandLogId,
      occurredAt: now,
    });
    const projectedScreening = projectScreening(screen.evaluation);

    await applyCommandStageIntervalTransition({
      commandName: "ApprovePV1",
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
        currentStatus: "PV1_APPROVED_READY_FOR_FILL" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
        verificationRecordId: verificationRecord.id,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.pv1.approved",
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
          bucketIdAfter: fillBucket.id,
          approvingPharmacistUserId,
          verificationRecordId: verificationRecord.id,
          commandLogId,
          // What the approval was screened against, in counts. A
          // non-zero `screeningGapCount` on an APPROVED order is the
          // honest statement that part of the screen could not be
          // performed and the pharmacist acknowledged that.
          screeningOutcome: projectedScreening.outcome,
          screeningFindingCount: projectedScreening.findingCount,
          screeningRequiresAcknowledgementCount: projectedScreening.requiresAcknowledgementCount,
          screeningGapCount: projectedScreening.gapCount,
        },
      },
      emits: [
        {
          eventType: "order.pv1.approved.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            approvingPharmacistUserId,
            bucketId: fillBucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            verificationRecordId: verificationRecord.id,
            occurredAt: now.toISOString(),
          },
        },
        {
          eventType: "order.pv1.screening.recorded.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            pharmacistUserId: approvingPharmacistUserId,
            phase: ScreeningPhase.PV1_APPROVE,
            screenedLineCount: screen.screenedLineCount,
            workflowPolicyId: policy.id,
            workflowPolicyVersion: policy.version,
            minimumReportedSeverity: screeningPolicy.minimumReportedSeverity,
            ...projectedScreening,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

// Re-export the bus's CAS error code for self-contained callers.
export { ORDER_VERSION_MISMATCH };
