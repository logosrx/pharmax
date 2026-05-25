// CancelOrder — terminal disposition for an order before shipment.
//
// What makes this command structurally different from the other
// order commands shipped so far:
//
//   - `CreateOrder` is a CREATE command (no lockTarget, policy by
//     code+version, no version CAS).
//   - `AddPrescription` is an in-flight WRITE command on a row in
//     specific states (RECEIVED, TYPING_*).
//   - `StartTyping` is a single-from-state TRANSITION command.
//
//   `CancelOrder` is the first MULTI-FROM-STATE command — it is
//   reachable from every non-terminal state (RECEIVED,
//   TYPING_IN_PROGRESS, TYPED_READY_FOR_PV1, PV1_IN_PROGRESS, …,
//   ON_HOLD, PV1_REJECTED, FINAL_VERIFICATION_REJECTED,
//   TYPING_PENDING_MISSING_INFO — see CANCEL_FROM_STATES in
//   `@pharmax/workflow/policy-v1`). The handler delegates the
//   from-state question to `applyTransition`; the engine returns
//   `WORKFLOW_STATE_TERMINAL` if the order is already SHIPPED or
//   CANCELLED, and the bus translates that to ConflictError.
//
// Workflow-safety rule satisfied here (see
// `.cursor/rules/01-workflow-safety.mdc`):
//
//   "Cancellation must go through CancelOrder command and requires:
//   disposition reason, user stamp, cancelled_from_status,
//   command_log, order_event, audit_log, event_outbox."
//
//   - disposition reason       → CancellationDisposition enum on the new row
//   - user stamp               → cancelledByUserId (= ctx.actor.userId), RESTRICT FK
//   - cancelled_from_status    → captured BEFORE the status flip in the same tx
//   - command_log              → the bus's pre-tx command_log row (id passed in)
//   - order_event              → factory writes per declared `emits[]`
//   - audit_log                → bus writes via the hash-chained writer
//   - event_outbox             → bus writes per declared `emits[]`
//
// What this handler does inside the bus's tx (post-lock, post-policy):
//
//   1. Translate currentState (engine-typed) and run the pure-engine
//      transition check. Map every WORKFLOW_* error to a stable
//      ORDER_* code:
//        - WORKFLOW_STATE_TERMINAL    → ORDER_ALREADY_TERMINAL
//        - WORKFLOW_INVALID_TRANSITION → ORDER_CANCEL_INVALID_FROM
//          (should be unreachable today — CANCEL_FROM_STATES is
//          exhaustive over non-terminals — but kept as a typed
//          escape hatch in case a future v2 policy narrows the
//          source-state set.)
//        - WORKFLOW_UNKNOWN_COMMAND   → InternalError (programmer error)
//   2. Insert the OrderCancellation row. The unique on `orderId` is
//      the structural anti-double-cancel guarantee: a concurrent
//      racer that bypasses the row lock (e.g. a future v2 path
//      that forgets to lock) still hits the unique violation and
//      we surface ORDER_ALREADY_CANCELLED.
//   3. Update the order: flip currentStatus to CANCELLED, null out
//      currentAssigneeUserId (no one is working a cancelled order).
//      We INTENTIONALLY do not change currentBucketId — the queue
//      UI filters by status, so a cancelled order disappears from
//      every active queue without a bucket move. (BUCKET_CODE_FOR_STATUS
//      documents this: "CANCELLED is terminal; the order leaves
//      all active queues, so no bucket mapping is needed.")
//   4. Factory then CAS-bumps `version` (separate updateMany so
//      concurrent writers surface as ORDER_VERSION_MISMATCH), and
//      writes `order_event { eventType: order.cancelled.v1, … }`,
//      `audit_log { action: order.cancelled, … }`, and `event_outbox`.
//
// PHI invariant:
//
//   `dispositionReasonText` is OPTIONAL free text. Operators may
//   legitimately write things like "patient passed away on …" — the
//   structured `dispositionReason` enum doesn't capture every nuance.
//   We treat that text as potential PHI:
//
//     (a) `redactFields: ["dispositionReasonText"]` censors it from
//         `command_log.requestPayload`. The bus's shallow redactor
//         runs at command boundary, so the redaction applies to
//         the row written PRE-tx.
//     (b) `audit_log.metadata` carries a `hasReasonText: boolean`,
//         NOT the text. SOC 2 auditors want to know "did the actor
//         provide context?" without exposing the PHI content of
//         that context.
//     (c) `order.cancelled.v1` outbox payload carries the structured
//         enum and the boolean, NOT the text. Downstream consumers
//         (billing event projection, dashboard counts, clinic
//         notification) can route on the enum.
//
//   The actual text lives on `order_cancellation.dispositionReasonText`
//   behind RLS, and a future "view cancellation details" read path
//   will gate access on `orders.read` + an additional flag if we
//   later split that read out as its own permission.
//
// SoD invariant:
//
//   No `sodRules` declared today. ORDERS_CANCEL is not in the SoD
//   registry — cancellation is a corrective/operational action, not
//   a verification step. If a future regulatory regime requires
//   "the actor who cancelled cannot be the one who created" that
//   rule will land in `@pharmax/rbac/separation-of-duties.ts` and
//   surface here via `sodRules`.
//
// Idempotency:
//
//   Bus-level via `idempotencyKey` (a retry returns the cached
//   response). Structural via the unique on `order_cancellation.orderId`:
//   a SECOND distinct command attempt for the same order lands on
//   ORDER_ALREADY_CANCELLED, not a silent write.

import { defineCommand } from "@pharmax/command-bus";
import { CancellationDisposition, OrderStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import {
  applyTransition,
  isOrderState,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
// ---------------------------------------------------------------------------

export const ORDER_CANCEL_POLICY_UNSUPPORTED = "ORDER_CANCEL_POLICY_UNSUPPORTED";
export const ORDER_STATE_UNKNOWN = "ORDER_STATE_UNKNOWN";
export const ORDER_ALREADY_TERMINAL = "ORDER_ALREADY_TERMINAL";
export const ORDER_CANCEL_INVALID_FROM = "ORDER_CANCEL_INVALID_FROM";
export const ORDER_ALREADY_CANCELLED = "ORDER_ALREADY_CANCELLED";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// `.strict()` rejects unknown keys at the boundary — keeps a future
// client from sneaking PHI into `command_log.requestPayload` by
// adding an undeclared field.
//
// `OTHER` requires `dispositionReasonText`. Every other reason
// treats the text as optional context. This is a Zod refinement
// (not a runtime check) because the cost of missing context on
// OTHER is large — closing the loop here means a SOC 2 reviewer
// reading the cancellation table can always answer "why?" without
// guessing.

const inputSchema = z
  .object({
    orderId: z.uuid(),
    dispositionReason: z.enum([
      CancellationDisposition.PATIENT_REQUEST,
      CancellationDisposition.PROVIDER_REQUEST,
      CancellationDisposition.CLINIC_REQUEST,
      CancellationDisposition.INSURANCE_DENIAL,
      CancellationDisposition.INVENTORY_UNAVAILABLE,
      CancellationDisposition.DUPLICATE_ORDER,
      CancellationDisposition.DATA_ENTRY_ERROR,
      CancellationDisposition.PATIENT_INELIGIBLE,
      CancellationDisposition.OTHER,
    ]),
    /**
     * Optional free-text context. MAY contain PHI. Always treated
     * as PHI by the bus's redactor; never appears in audit or
     * outbox payloads. Required when `dispositionReason === OTHER`.
     */
    dispositionReasonText: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.dispositionReason !== CancellationDisposition.OTHER ||
      (typeof v.dispositionReasonText === "string" && v.dispositionReasonText.trim().length > 0),
    {
      message:
        "dispositionReasonText is required when dispositionReason === OTHER. Choose a structured reason or supply free-text context.",
      path: ["dispositionReasonText"],
    }
  );

export type CancelOrderInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CancelOrderOutput {
  readonly orderId: string;
  readonly cancellationId: string;
  readonly currentStatus: "CANCELLED";
  readonly cancelledFromStatus: string;
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const CancelOrder = defineCommand<CancelOrderInput, CancelOrderOutput>({
  name: "CancelOrder",
  inputSchema,
  permission: PERMISSIONS.ORDERS_CANCEL,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  // The free-text reason MAY carry PHI; the bus's shallow redactor
  // censors it from command_log.requestPayload. The structured
  // enum and the orderId remain visible — they're the SOC 2
  // forensic signal.
  redactFields: ["dispositionReasonText"],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "CANCEL_ORDER_NO_TARGET",
        message: "Locked target was not provided to CancelOrder handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "CANCEL_ORDER_NO_POLICY",
        message: "Workflow policy was not loaded for CancelOrder.",
      });
    }

    // Resolve the in-memory engine policy. The locked order carries
    // a (code, version) pair that pins which version's transition
    // table governs this row. Only v1 ships today; v2 will be a
    // separate handler in a future package.
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: ORDER_CANCEL_POLICY_UNSUPPORTED,
        message:
          "CancelOrder handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const fromState: OrderState = target.currentStatus;

    // Pure-engine guard — TOTAL function, no I/O, no clock. The
    // engine encapsulates the "is CANCEL allowed from <state>?"
    // question; we just map its result codes to the command's
    // public vocabulary.
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState: fromState,
      command: "CANCEL",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: ORDER_ALREADY_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: ORDER_CANCEL_INVALID_FROM,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          // WORKFLOW_PARAM_* don't apply to CANCEL (no params).
          // Anything that lands here is an unforeseen engine
          // outcome — fail loudly.
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    const now = clock.now();
    const reasonText =
      typeof input.dispositionReasonText === "string" &&
      input.dispositionReasonText.trim().length > 0
        ? input.dispositionReasonText
        : null;
    const hasReasonText = reasonText !== null;

    // ---- Insert the OrderCancellation row ----
    // The unique on `orderId` makes a double-cancel structurally
    // impossible. We catch Prisma's P2002 and surface a typed
    // ORDER_ALREADY_CANCELLED so the API layer can return a stable
    // 409. (Under the bus's row lock this branch should be
    // unreachable for honest callers — but the constraint protects
    // against future code that forgets to lock.)
    let cancellation: { id: string };
    try {
      cancellation = await tx.orderCancellation.create({
        data: {
          organizationId: ctx.organizationId,
          orderId: target.id,
          dispositionReason: input.dispositionReason,
          dispositionReasonText: reasonText,
          cancelledByUserId: ctx.actor.userId,
          cancelledFromStatus: fromState as OrderStatus,
          cancelledAt: now,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          commandLogId,
        },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: ORDER_ALREADY_CANCELLED,
          message: "This order has already been cancelled.",
          metadata: { orderId: target.id },
        });
      }
      throw err;
    }

    // ---- Flip the order to CANCELLED ----
    // currentBucketId intentionally unchanged — see file-header
    // note. currentAssigneeUserId is nulled out: no one is working
    // a cancelled order. version is left to the factory's CAS
    // step.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.CANCELLED,
        currentAssigneeUserId: null,
      },
    });

    const nextVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        cancellationId: cancellation.id,
        currentStatus: "CANCELLED" as const,
        cancelledFromStatus: fromState,
        version: nextVersion,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.cancelled",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          cancellationId: cancellation.id,
          fromState: transition.fromState,
          toState: transition.toState,
          transitionId: transition.transitionId,
          dispositionReason: input.dispositionReason,
          hasReasonText,
          cancelledByUserId: ctx.actor.userId,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.cancelled.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            cancellationId: cancellation.id,
            dispositionReason: input.dispositionReason,
            hasReasonText,
            cancelledByUserId: ctx.actor.userId,
            cancelledFromStatus: fromState,
            transitionId: transition.transitionId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
