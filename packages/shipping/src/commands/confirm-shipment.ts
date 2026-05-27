import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus, ShipmentStatus } from "@pharmax/database";
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

import { assertShippingAssignee, SHIP_NOT_ASSIGNED_TO_ACTOR } from "../shipping-guards.js";
import {
  SHIP_INVALID_TRANSITION,
  SHIP_ORDER_STATE_UNKNOWN,
  SHIP_ORDER_TERMINAL,
  SHIP_POLICY_UNSUPPORTED,
  SHIPPING_BUCKET_NOT_CONFIGURED,
} from "./release-to-ship.js";

export const SHIPMENT_NOT_FOUND = "SHIPMENT_NOT_FOUND";
export const SHIPMENT_NOT_READY = "SHIPMENT_NOT_READY";

const inputSchema = z.object({ orderId: z.uuid() }).strict();

export type ConfirmShipmentInput = z.infer<typeof inputSchema>;

export interface ConfirmShipmentOutput {
  readonly orderId: string;
  readonly currentStatus: "SHIPPED";
  readonly shipmentId: string;
  readonly version: number;
  readonly transitionId: string;
}

export const ConfirmShipment = defineCommand<ConfirmShipmentInput, ConfirmShipmentOutput>({
  name: "ConfirmShipment",
  inputSchema,
  permission: PERMISSIONS.SHIP_CONFIRM,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "CONFIRM_SHIPMENT_NO_TARGET",
        message: "Locked order target was not provided to ConfirmShipment.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "CONFIRM_SHIPMENT_NO_POLICY",
        message: "Workflow policy was not loaded for ConfirmShipment.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: SHIP_POLICY_UNSUPPORTED,
        message: "ConfirmShipment handler is wired only for order.standard v1.",
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
      command: "CONFIRM_SHIPMENT",
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

    await assertShippingAssignee({ tx, target, ctx });

    const shipment = await tx.shipment.findFirst({
      where: { organizationId: ctx.organizationId, orderId: target.id },
      select: { id: true, status: true, trackingNumber: true },
    });
    if (shipment === null) {
      throw new errors.ConflictError({
        code: SHIPMENT_NOT_FOUND,
        message: "Create a shipment before confirming handoff.",
        metadata: { orderId: target.id },
      });
    }
    if (shipment.status !== ShipmentStatus.CREATED) {
      throw new errors.ConflictError({
        code: SHIPMENT_NOT_READY,
        message: "Shipment is not in a confirmable state.",
        metadata: { orderId: target.id, shipmentId: shipment.id, status: shipment.status },
      });
    }

    const shippingBucketCode = BUCKET_CODE_FOR_STATUS.SHIPPED;
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

    const now = clock.now();
    const shippingClerkUserId = ctx.actor.userId;

    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.CONFIRMED,
        confirmedByUserId: shippingClerkUserId,
        confirmCommandLogId: commandLogId,
        confirmedAt: now,
      },
    });

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.SHIPPED,
        currentBucketId: shippingBucket.id,
        currentAssigneeUserId: null,
        shippedAt: now,
      },
    });

    await applyCommandStageIntervalTransition({
      commandName: "ConfirmShipment",
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      at: now,
      commandLogId,
      actorUserId: shippingClerkUserId,
    });

    return {
      output: {
        orderId: target.id,
        currentStatus: "SHIPPED" as const,
        shipmentId: shipment.id,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.shipped",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          shipmentId: shipment.id,
          trackingNumber: shipment.trackingNumber,
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
          eventType: "order.shipped.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            // clinicId surfaced so the billing materialization
            // outbox handler (see apps/worker/src/drains/
            // materialize-billing-on-order-shipped.ts) can attribute
            // the invoice line to the right clinic without a
            // second cross-tenant lookup.
            clinicId: target.clinicId,
            siteId: target.siteId,
            shipmentId: shipment.id,
            trackingNumber: shipment.trackingNumber,
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

export { ORDER_VERSION_MISMATCH, SHIP_NOT_ASSIGNED_TO_ACTOR };
