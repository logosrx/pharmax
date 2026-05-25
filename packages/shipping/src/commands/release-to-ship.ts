// ReleaseToShip — a shipping clerk claims an order from the SHIPPING
// queue and marks it ready for carrier handoff.
//
// Why this is the first SHIPPING-stage command:
//
//   ApproveFinalVerification cleared the assignee and parked the
//   order in the SHIPPING bucket at
//   `FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP`. This command is
//   the counterpart to StartFill / StartPV1 — the clerk claims
//   ownership, the status moves to `READY_TO_SHIP`, and downstream
//   commands (`CreateShipment`, `ConfirmShipment`) operate on an
//   order the clerk owns.
//
// Prerequisite invariant (workflow-safety.mdc):
//
//   RELEASE_TO_SHIP is only legal from
//   `FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP`. The pure engine
//   enforces "no ship before final verification approval" — there
//   is no transition row from any pre-final-approval state.
//   Attempting to release from `FINAL_VERIFICATION_IN_PROGRESS` or
//   `FILL_COMPLETED_READY_FOR_FINAL` surfaces `SHIP_INVALID_TRANSITION`.
//
// SoD invariant:
//
//   No `sodRules` clause. Shipping release is an operational claim,
//   not a pharmacist sign-off. The two-pharmacist safety net closed
//   at `ApproveFinalVerification`.
//
// Assignee semantics:
//
//   Symmetric to StartFill: ApproveFinalVerification cleared the
//   assignee to NULL; this command sets
//   `currentAssigneeUserId = ctx.actor.userId`. ConfirmShipment
//   will clear it again when the order reaches terminal `SHIPPED`.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox payload
//   reference scope (orderId, organizationId, siteId,
//   shippingClerkUserId, bucketIdAfter) and workflow identity — zero
//   patient PHI.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
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

export const SHIP_POLICY_UNSUPPORTED = "SHIP_POLICY_UNSUPPORTED";
export const SHIP_ORDER_STATE_UNKNOWN = "SHIP_ORDER_STATE_UNKNOWN";
export const SHIP_INVALID_TRANSITION = "SHIP_INVALID_TRANSITION";
export const SHIP_ORDER_TERMINAL = "SHIP_ORDER_TERMINAL";
/** Same string as `@pharmax/verification`'s `approve-final-verification.ts`. */
export const SHIPPING_BUCKET_NOT_CONFIGURED = "SHIPPING_BUCKET_NOT_CONFIGURED";

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type ReleaseToShipInput = z.infer<typeof inputSchema>;

export interface ReleaseToShipOutput {
  readonly orderId: string;
  readonly currentStatus: "READY_TO_SHIP";
  readonly version: number;
  readonly transitionId: string;
}

export const ReleaseToShip = defineCommand<ReleaseToShipInput, ReleaseToShipOutput>({
  name: "ReleaseToShip",
  inputSchema,
  permission: PERMISSIONS.SHIP_RELEASE,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "RELEASE_TO_SHIP_NO_TARGET",
        message: "Locked target was not provided to ReleaseToShip handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "RELEASE_TO_SHIP_NO_POLICY",
        message: "Workflow policy was not loaded for ReleaseToShip.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: SHIP_POLICY_UNSUPPORTED,
        message:
          "ReleaseToShip handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: SHIP_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "RELEASE_TO_SHIP",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: SHIP_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: SHIP_INVALID_TRANSITION,
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

    const shippingBucketCode = BUCKET_CODE_FOR_STATUS.READY_TO_SHIP;
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

    const shippingClerkUserId = ctx.actor.userId;

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.READY_TO_SHIP,
        currentBucketId: shippingBucket.id,
        currentAssigneeUserId: shippingClerkUserId,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "ReleaseToShip",
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
        currentStatus: "READY_TO_SHIP" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.ship.released",
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
          shippingClerkUserId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.ship.released.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            shippingClerkUserId,
            bucketId: shippingBucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
