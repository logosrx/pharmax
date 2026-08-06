// AcknowledgePV1ScreeningFinding — a pharmacist records their
// judgement on one clinical-screening finding, which is what lets
// `ApprovePV1` pass it.
//
// Why this is a command and not a checkbox on the approve request:
//
//   An acknowledgement is a professional act with a name on it. If it
//   arrived as a field on ApprovePV1 — `acknowledgedFingerprints:
//   [...]` — it would be indistinguishable from the client asserting
//   "I dealt with these", and the natural client implementation is to
//   send whatever the last screen returned. As its own command it
//   gets an idempotency key, a command_log row, an order_event, an
//   audit row and an outbox event, each stamped with the actor and
//   the moment; and it is refused unless the fingerprint corresponds
//   to a finding that was actually persisted for this order and
//   actually requires acknowledgement.
//
// Permission: PV1_APPROVE, deliberately NOT a new permission.
//
//   The acknowledge tier exists to gate an approval. The authority to
//   record the judgement that opens that gate is the authority to
//   sign the approval itself — anything looser would let a role that
//   cannot approve pre-clear the findings for someone who can, which
//   is the same failure as inheriting a colleague's acknowledgement.
//   Adding a separate `pv1.acknowledge_screening` permission would
//   also have to be granted alongside PV1_APPROVE in every role
//   template to be usable, and a permission that is always granted
//   with another is not a permission, it is a comment.
//
// What this command does NOT do:
//
//   - It does not touch `order.currentStatus`, and it returns no
//     `bumpVersion`. Recording a judgement is not a workflow
//     transition; the order stays in PV1_IN_PROGRESS and the version
//     counter stays where the last real transition left it. Bumping
//     it would make every acknowledgement invalidate a concurrent
//     command's CAS for no safety benefit.
//   - It cannot acknowledge a HARD_STOP. An unoverridable finding
//     that could be acknowledged would not be unoverridable, just
//     slower — see `PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE`.
//   - It does not accept a note. Free text a human typed is the one
//     thing the screening tables must not hold; if a note is ever
//     wanted it belongs in an encrypted column with its own read
//     path.
//
// TWO SCOPES, ONE COMMAND, AND THE FINDING ROW DECIDES — never the
// caller. After the fingerprint is resolved to a persisted finding,
// `asPatientRecordGap` classifies it:
//
//   - A PATIENT-RECORD gap (a PER_SUBJECT axis reporting
//     NOT_RECORDED_FOR_SUBJECT — today exactly
//     SCR_ALLERGY_INPUT_UNAVAILABLE) is recorded in
//     `patient_screening_acknowledgement`, keyed by PATIENT and
//     stamped with the record-state token, so the same pharmacist is
//     not re-charged for the same unchanged record on the patient's
//     next order — and IS re-prompted the moment the record changes,
//     because the token stops matching. See `patient-scope.ts` for
//     the boundary argument and the re-arming design.
//   - Everything else — every clinical finding, knowledge gaps,
//     per-record gaps — is recorded per (organization, order,
//     pharmacist, fingerprint) exactly as before. A clinical finding
//     structurally cannot take the patient path: the classifier
//     refuses it, and the patient table's CHECK constraints refuse
//     its code.
//
// There is no input by which a caller can choose the scope, for the
// same reason the grading is copied from the finding row: a request
// that could say "make this one patient-wide" would let a client
// widen the suppression of a safety prompt.
//
// Idempotency: two layers. The bus replays an identical
// (command, key) pair without re-running the handler; and beneath
// that, the unique index on (organization, order, pharmacist,
// fingerprint) — or, for the patient scope, (organization, patient,
// pharmacist, fingerprint, recordStateToken) — means a second
// acknowledgement under a DIFFERENT key resolves to the existing row
// and emits nothing rather than either duplicating the record or
// failing on a constraint the caller cannot see. Note what the
// patient-scoped key's token component buys: re-acknowledging a gap
// that RE-AROSE after the record changed is NOT a repeat — it is a
// fresh judgement about a different record state, and it takes a
// fresh row.
//
// PHI invariant: input is an orderId and a fingerprint — a hash-like
// identity string computed from finding codes. The persisted row and
// the event carry codes and gradings copied from the finding row, not
// from the caller. The patient-scoped event names the patientId (the
// same opaque id `patient.allergy.recorded.v1` already carries) and
// the record-state token, which is a SHA-256 over record ids and
// coded statuses — no substance, no narrative.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { isOrderState } from "@pharmax/workflow";
import { z } from "zod";

import {
  PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE,
  PV1_SCREENING_FINDING_UNKNOWN,
  PV1_SCREENING_STAGE_INVALID,
} from "../screening/errors.js";
import { loadPatientIdForOrder } from "../screening/order-patient.js";
import { asPatientRecordGap, patientRecordStateToken } from "../screening/patient-scope.js";

import { PV1_ORDER_STATE_UNKNOWN, PV1_POLICY_UNSUPPORTED } from "./start-pv1.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    /**
     * The finding's `fingerprint`, as produced by `fingerprintOf` and
     * persisted on `order_screening_finding`. Bounded because it is a
     * caller-supplied string that reaches an indexed column; the real
     * validation is the lookup below, which refuses anything the
     * engine did not itself produce for this order.
     */
    fingerprint: z.string().min(1).max(512),
  })
  .strict();

export type AcknowledgePV1ScreeningFindingInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface AcknowledgePV1ScreeningFindingOutput {
  readonly orderId: string;
  readonly fingerprint: string;
  readonly acknowledgementId: string;
  /**
   * True when this pharmacist had already acknowledged this
   * fingerprint at this scope (on this order, or — for a
   * patient-record gap — for this patient at the current record
   * state) and the call was a no-op. Distinguished from a fresh
   * acknowledgement so a console can tell "recorded" from "already
   * recorded" without a second read.
   */
  readonly alreadyAcknowledged: boolean;
  /**
   * Where the judgement was filed, decided by the finding row and
   * never by the caller: PATIENT for a per-subject record gap, ORDER
   * for everything else.
   */
  readonly scope: "ORDER" | "PATIENT";
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const AcknowledgePV1ScreeningFinding = defineCommand<
  AcknowledgePV1ScreeningFindingInput,
  AcknowledgePV1ScreeningFindingOutput
>({
  name: "AcknowledgePV1ScreeningFinding",
  inputSchema,
  permission: PERMISSIONS.PV1_APPROVE,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "ACKNOWLEDGE_PV1_SCREENING_NO_TARGET",
        message: "Locked target was not provided to AcknowledgePV1ScreeningFinding handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "ACKNOWLEDGE_PV1_SCREENING_NO_POLICY",
        message: "Workflow policy was not loaded for AcknowledgePV1ScreeningFinding.",
      });
    }
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: PV1_POLICY_UNSUPPORTED,
        message:
          "AcknowledgePV1ScreeningFinding is wired only for order.standard v1. " +
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
    // No `applyTransition` call: this command is not a transition, so
    // the policy has nothing to say about it. The state check is
    // direct — a judgement only means something while a review is
    // open. Recording one on an order that has already been approved
    // (or rejected, or cancelled) would let a fingerprint be settled
    // after the fact and go on to satisfy a LATER approval that never
    // displayed it.
    if (target.currentStatus !== OrderStatus.PV1_IN_PROGRESS) {
      throw new errors.ConflictError({
        code: PV1_SCREENING_STAGE_INVALID,
        message: "Screening findings can only be acknowledged while the order is in PV1 review.",
        metadata: { orderId: target.id, currentStatus: target.currentStatus },
      });
    }

    const pharmacistUserId = ctx.actor.userId;

    // The finding must have been SHOWN before it can be settled. This
    // is what stops a client acknowledging a fingerprint it computed
    // locally, and — the common case — what makes a stale console
    // fail loudly after a re-screen changed the findings.
    //
    // `orderBy occurredAt desc` picks the most recent row for the
    // fingerprint: the same clinical situation re-detected by a later
    // screen carries the same fingerprint by construction (severity
    // and certainty are part of it), so any matching row states the
    // same grading. Taking the latest keeps the copied grading aligned
    // with what the pharmacist is currently looking at.
    const finding = await tx.orderScreeningFinding.findFirst({
      where: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        fingerprint: input.fingerprint,
      },
      orderBy: { occurredAt: "desc" },
      select: { code: true, kind: true, severity: true, certainty: true, disposition: true },
    });
    if (finding === null) {
      throw new errors.InvariantViolationError({
        code: PV1_SCREENING_FINDING_UNKNOWN,
        message:
          "No screening finding with this fingerprint has been recorded for this order. " +
          "If the order was re-screened, re-read the current findings before acknowledging.",
        metadata: { orderId: target.id, fingerprint: input.fingerprint },
      });
    }
    if (finding.disposition !== "REQUIRES_ACKNOWLEDGEMENT") {
      throw new errors.InvariantViolationError({
        code: PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE,
        message:
          finding.disposition === "HARD_STOP"
            ? "This finding cannot be dispensed against and cannot be acknowledged; it has no override path."
            : "This finding is informational and does not require an acknowledgement.",
        metadata: {
          orderId: target.id,
          fingerprint: input.fingerprint,
          disposition: finding.disposition,
        },
      });
    }

    // Scope decision — made from the persisted finding row, so a
    // caller cannot widen it. Non-null exactly when this is a
    // per-subject record gap; see `patient-scope.ts`.
    const patientRecordGap = asPatientRecordGap({
      kind: finding.kind,
      code: finding.code,
      disposition: finding.disposition,
      fingerprint: input.fingerprint,
    });

    if (patientRecordGap !== null) {
      const patientId = await loadPatientIdForOrder({
        tx,
        organizationId: ctx.organizationId,
        orderId: target.id,
      });
      // The record state this judgement binds to, read inside this
      // same transaction. If the record changes between now and the
      // approval, the gate's own hash stops matching and the
      // pharmacist is asked again — which is correct, because the
      // record they acknowledged is not the record on file.
      const recordStateToken = await patientRecordStateToken(
        { tx, organizationId: ctx.organizationId, patientId },
        patientRecordGap.axis
      );

      const existingPatientAck = await tx.patientScreeningAcknowledgement.findFirst({
        where: {
          organizationId: ctx.organizationId,
          patientId,
          pharmacistUserId,
          fingerprint: input.fingerprint,
          recordStateToken,
        },
        select: { id: true },
      });
      if (existingPatientAck !== null) {
        // Already on record for this patient at this record state.
        // Same posture as the order-scoped repeat below: no event,
        // audit only.
        return {
          output: {
            orderId: target.id,
            fingerprint: input.fingerprint,
            acknowledgementId: existingPatientAck.id,
            alreadyAcknowledged: true,
            scope: "PATIENT" as const,
          },
          targetOrderId: target.id,
          audit: {
            action: "order.pv1.screening.acknowledgement_repeated",
            resourceType: "Order",
            resourceId: target.id,
            metadata: {
              orderId: target.id,
              patientId,
              pharmacistUserId,
              fingerprint: input.fingerprint,
              findingCode: finding.code,
              acknowledgementId: existingPatientAck.id,
              scope: "PATIENT",
              commandLogId,
            },
          },
          emits: [],
        };
      }

      const now = clock.now();

      const patientAcknowledgement = await tx.patientScreeningAcknowledgement.create({
        data: {
          organizationId: ctx.organizationId,
          patientId,
          orderId: target.id,
          axis: patientRecordGap.axis,
          fingerprint: input.fingerprint,
          // Copied from the finding row, never from the caller — same
          // rule as the order-scoped row.
          findingCode: finding.code,
          severity: finding.severity,
          certainty: finding.certainty,
          recordStateToken,
          pharmacistUserId,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          commandLogId,
          acknowledgedAt: now,
        },
        select: { id: true },
      });

      return {
        output: {
          orderId: target.id,
          fingerprint: input.fingerprint,
          acknowledgementId: patientAcknowledgement.id,
          alreadyAcknowledged: false,
          scope: "PATIENT" as const,
        },
        targetOrderId: target.id,
        audit: {
          action: "order.pv1.screening.acknowledged_for_patient",
          resourceType: "Order",
          resourceId: target.id,
          metadata: {
            orderId: target.id,
            patientId,
            pharmacistUserId,
            axis: patientRecordGap.axis,
            fingerprint: input.fingerprint,
            findingCode: finding.code,
            severity: finding.severity,
            certainty: finding.certainty,
            recordStateToken,
            workflowPolicyId: policy.id,
            workflowPolicyVersion: policy.version,
            acknowledgementId: patientAcknowledgement.id,
            commandLogId,
          },
        },
        emits: [
          {
            eventType: "order.pv1.screening.acknowledged_for_patient.v1",
            aggregateType: "Order",
            aggregateId: target.id,
            payload: {
              orderId: target.id,
              organizationId: ctx.organizationId,
              siteId: target.siteId,
              patientId,
              pharmacistUserId,
              axis: patientRecordGap.axis,
              fingerprint: input.fingerprint,
              findingCode: finding.code,
              severity: finding.severity,
              certainty: finding.certainty,
              recordStateToken,
              workflowPolicyId: policy.id,
              workflowPolicyVersion: policy.version,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    }

    const existing = await tx.orderScreeningAcknowledgement.findFirst({
      where: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        pharmacistUserId,
        fingerprint: input.fingerprint,
      },
      select: { id: true },
    });
    if (existing !== null) {
      // Already on record. Emit nothing: a second event would put a
      // duplicate "acknowledged" entry on the order timeline for what
      // is, in practice, a double-click. The audit row below still
      // records that the attempt was made.
      return {
        output: {
          orderId: target.id,
          fingerprint: input.fingerprint,
          acknowledgementId: existing.id,
          alreadyAcknowledged: true,
          scope: "ORDER" as const,
        },
        targetOrderId: target.id,
        audit: {
          action: "order.pv1.screening.acknowledgement_repeated",
          resourceType: "Order",
          resourceId: target.id,
          metadata: {
            orderId: target.id,
            pharmacistUserId,
            fingerprint: input.fingerprint,
            findingCode: finding.code,
            acknowledgementId: existing.id,
            commandLogId,
          },
        },
        emits: [],
      };
    }

    const now = clock.now();

    const acknowledgement = await tx.orderScreeningAcknowledgement.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        fingerprint: input.fingerprint,
        // Copied from the finding row, never from the caller: an
        // acknowledgement must not be able to claim a grading the
        // engine did not produce.
        findingCode: finding.code,
        severity: finding.severity,
        certainty: finding.certainty,
        pharmacistUserId,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        commandLogId,
        acknowledgedAt: now,
      },
      select: { id: true },
    });

    return {
      output: {
        orderId: target.id,
        fingerprint: input.fingerprint,
        acknowledgementId: acknowledgement.id,
        alreadyAcknowledged: false,
        scope: "ORDER" as const,
      },
      targetOrderId: target.id,
      audit: {
        action: "order.pv1.screening.acknowledged",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          pharmacistUserId,
          fingerprint: input.fingerprint,
          findingCode: finding.code,
          severity: finding.severity,
          certainty: finding.certainty,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          acknowledgementId: acknowledgement.id,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.pv1.screening.acknowledged.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            pharmacistUserId,
            fingerprint: input.fingerprint,
            findingCode: finding.code,
            severity: finding.severity,
            certainty: finding.certainty,
            workflowPolicyId: policy.id,
            workflowPolicyVersion: policy.version,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
