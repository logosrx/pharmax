// PlaceHold — pause an order in flight while a blocker is resolved.
//
// PlaceHold is the FIRST half of the platform's reversible
// structured-record pattern. CancelOrder established the terminal
// version (one row per order, status flips to a terminal state);
// PlaceHold + ReleaseHold establish the reversible version:
//
//   - PlaceHold INSERTs a new `order_hold` row, captures the prior
//     status as `heldFromStatus`, flips `order.currentStatus` to
//     `ON_HOLD`, and emits `order.held.v1`.
//   - ReleaseHold UPDATEs the SAME row with release columns,
//     flips `order.currentStatus` back to `heldFromStatus` (or a
//     supervisor-supplied override), and emits
//     `order.hold_released.v1`.
//
// One order may pass through many hold cycles over its lifetime
// (held → released → held → released). The structural anti-double-
// place guarantee is a PARTIAL UNIQUE INDEX on
// `(orderId) WHERE releasedAt IS NULL` declared in the migration:
// at most one ACTIVE hold per order at a time. A second PlaceHold
// while a hold is active lands on the unique violation and surfaces
// as ORDER_ALREADY_ON_HOLD.
//
// Workflow-safety rule satisfied here (see
// `.cursor/rules/01-workflow-safety.mdc`):
//
//   "Every hold requires a reason code."
//
//   - reason code            → HoldReason enum on the new row
//   - user stamp             → heldByUserId (= ctx.actor.userId), RESTRICT FK
//   - held_from_status       → captured BEFORE the status flip in the same tx
//   - command_log            → the bus's pre-tx command_log row (id passed in)
//   - order_event            → factory writes per declared `emits[]`
//   - audit_log              → bus writes via the hash-chained writer
//   - event_outbox           → bus writes per declared `emits[]`
//
// Multi-from-state: PLACE_HOLD is allowed from every active (non-
// terminal, non-hold) state — see HOLD_FROM_STATES in
// `@pharmax/workflow/policy-v1`. The engine returns
// WORKFLOW_INVALID_TRANSITION when the source state is `ON_HOLD`
// (you can't place a hold on a held order; the partial unique
// would catch this too, but the engine catches it earlier and
// produces a clearer error message).
// WORKFLOW_STATE_TERMINAL fires when the source is `SHIPPED` or
// `CANCELLED`.
//
// PHI invariant:
//
//   `reasonText` is OPTIONAL free text. Operators may write things
//   like "patient cannot afford copay until Tuesday" — the
//   structured `reason` enum doesn't capture every nuance. We
//   treat that text as potential PHI:
//
//     (a) `redactFields: ["reasonText"]` censors it from
//         `command_log.requestPayload`.
//     (b) `audit_log.metadata` carries a `hasReasonText: boolean`,
//         NOT the text.
//     (c) `order.held.v1` outbox payload carries the structured
//         enum and the boolean, NOT the text.
//
//   The text lives only on the `order_hold` row, behind RLS.
//
// SoD invariant:
//
//   No `sodRules` declared. ORDERS_PLACE_HOLD has no per-actor
//   correlation with earlier acts today; holds are corrective and
//   may be placed by the same actor who started typing or PV1.
//   If a future policy requires "the actor who placed the hold
//   cannot be the one who released it" that rule will land in
//   `@pharmax/rbac/separation-of-duties.ts` and surface on
//   ReleaseHold (the asymmetric check is on release, not place).
//
// Idempotency:
//
//   Bus-level via `idempotencyKey`. Structural via the partial
//   unique on `(orderId) WHERE releasedAt IS NULL`: a SECOND
//   distinct command attempt while a hold is active lands on
//   ORDER_ALREADY_ON_HOLD, not a silent duplicate row.

import { defineCommand } from "@pharmax/command-bus";
import { HoldReason, OrderStatus, Prisma } from "@pharmax/database";
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

export const ORDER_PLACE_HOLD_POLICY_UNSUPPORTED = "ORDER_PLACE_HOLD_POLICY_UNSUPPORTED";
export const ORDER_HOLD_STATE_UNKNOWN = "ORDER_HOLD_STATE_UNKNOWN";
export const ORDER_HOLD_INVALID_FROM = "ORDER_HOLD_INVALID_FROM";
export const ORDER_HOLD_TERMINAL_STATE = "ORDER_HOLD_TERMINAL_STATE";
export const ORDER_ALREADY_ON_HOLD = "ORDER_ALREADY_ON_HOLD";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// `.strict()` rejects unknown keys at the boundary — keeps a future
// client from sneaking PHI into `command_log.requestPayload` via
// an undeclared field.
//
// `OTHER` requires `reasonText` (same as CancelOrder's OTHER
// disposition). Every other reason treats text as optional context.

const inputSchema = z
  .object({
    orderId: z.uuid(),
    reason: z.enum([
      HoldReason.WAITING_FOR_PROVIDER,
      HoldReason.WAITING_FOR_PATIENT,
      HoldReason.WAITING_FOR_INSURANCE,
      HoldReason.INVENTORY_BACKORDER,
      HoldReason.PRESCRIPTION_AMBIGUITY,
      HoldReason.COMPLIANCE_REVIEW,
      HoldReason.DUPLICATE_INVESTIGATION,
      HoldReason.OTHER,
    ]),
    /**
     * Optional free-text context. MAY contain PHI. Redacted from
     * `command_log.requestPayload`; replaced with a boolean
     * `hasReasonText` in audit + outbox. Required when
     * `reason === OTHER`.
     */
    reasonText: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.reason !== HoldReason.OTHER ||
      (typeof v.reasonText === "string" && v.reasonText.trim().length > 0),
    {
      message:
        "reasonText is required when reason === OTHER. Choose a structured reason or supply free-text context.",
      path: ["reasonText"],
    }
  );

export type PlaceHoldInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface PlaceHoldOutput {
  readonly orderId: string;
  readonly holdId: string;
  readonly currentStatus: "ON_HOLD";
  readonly heldFromStatus: string;
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const PlaceHold = defineCommand<PlaceHoldInput, PlaceHoldOutput>({
  name: "PlaceHold",
  inputSchema,
  permission: PERMISSIONS.ORDERS_PLACE_HOLD,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: ["reasonText"],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "PLACE_HOLD_NO_TARGET",
        message: "Locked target was not provided to PlaceHold handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "PLACE_HOLD_NO_POLICY",
        message: "Workflow policy was not loaded for PlaceHold.",
      });
    }

    // Only v1 ships today; a future v2 will land as a separate
    // handler that registers under the v2 policy.
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: ORDER_PLACE_HOLD_POLICY_UNSUPPORTED,
        message:
          "PlaceHold handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: ORDER_HOLD_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const fromState: OrderState = target.currentStatus;

    // Pure-engine guard. The engine knows PLACE_HOLD is allowed
    // from HOLD_FROM_STATES and rejects ON_HOLD with
    // WORKFLOW_INVALID_TRANSITION and SHIPPED/CANCELLED with
    // WORKFLOW_STATE_TERMINAL.
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState: fromState,
      command: "PLACE_HOLD",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: ORDER_HOLD_TERMINAL_STATE,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: ORDER_HOLD_INVALID_FROM,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          // PLACE_HOLD has no params; WORKFLOW_PARAM_* paths
          // don't apply. Anything else is unforeseen.
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    const now = clock.now();
    const reasonText =
      typeof input.reasonText === "string" && input.reasonText.trim().length > 0
        ? input.reasonText
        : null;
    const hasReasonText = reasonText !== null;

    // ---- Insert the OrderHold row ----
    // The PARTIAL unique on `(orderId) WHERE releasedAt IS NULL`
    // makes "place a second hold while one is active" structurally
    // impossible. Concurrent racer that somehow bypasses the row
    // lock still hits the unique violation; we surface it as a
    // typed ORDER_ALREADY_ON_HOLD.
    let hold: { id: string };
    try {
      hold = await tx.orderHold.create({
        data: {
          organizationId: ctx.organizationId,
          orderId: target.id,
          reason: input.reason,
          reasonText,
          heldByUserId: ctx.actor.userId,
          heldFromStatus: fromState as OrderStatus,
          heldAt: now,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          placeCommandLogId: commandLogId,
        },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: ORDER_ALREADY_ON_HOLD,
          message: "This order already has an active hold; release it before placing another.",
          metadata: { orderId: target.id },
        });
      }
      throw err;
    }

    // ---- Flip the order to ON_HOLD ----
    // currentBucketId intentionally unchanged: the queue UI filters
    // by `currentStatus`, so a held order disappears from active
    // queues without a bucket move. currentAssigneeUserId is nulled
    // — no one is actively working a held order; on release, the
    // operator picks it up fresh.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.ON_HOLD,
        currentAssigneeUserId: null,
      },
    });

    const nextVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        holdId: hold.id,
        currentStatus: "ON_HOLD" as const,
        heldFromStatus: fromState,
        version: nextVersion,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.held",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          holdId: hold.id,
          fromState: transition.fromState,
          toState: transition.toState,
          transitionId: transition.transitionId,
          reason: input.reason,
          hasReasonText,
          heldByUserId: ctx.actor.userId,
          heldFromStatus: fromState,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.held.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            holdId: hold.id,
            reason: input.reason,
            hasReasonText,
            heldByUserId: ctx.actor.userId,
            heldFromStatus: fromState,
            transitionId: transition.transitionId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
