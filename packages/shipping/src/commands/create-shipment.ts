import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  assertReadyToShipWithAssignee,
  assertShippingAssignee,
  SHIP_NOT_ASSIGNED_TO_ACTOR,
  SHIP_WRONG_STATUS,
} from "../shipping-guards.js";

export const SHIPMENT_ALREADY_EXISTS = "SHIPMENT_ALREADY_EXISTS";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    carrier: z.enum([
      ShipmentCarrier.USPS,
      ShipmentCarrier.UPS,
      ShipmentCarrier.FEDEX,
      ShipmentCarrier.DHL,
      ShipmentCarrier.OTHER,
    ]),
    serviceLevel: z.string().min(1).max(64),
    trackingNumber: z.string().min(1).max(128),
    externalShipmentId: z.string().min(1).max(128).optional(),
    externalTrackerId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type CreateShipmentInput = z.infer<typeof inputSchema>;

export interface CreateShipmentOutput {
  readonly orderId: string;
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly version: number;
}

export const CreateShipment = defineCommand<CreateShipmentInput, CreateShipmentOutput>({
  name: "CreateShipment",
  inputSchema,
  permission: PERMISSIONS.SHIP_CREATE,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: [],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "CREATE_SHIPMENT_NO_TARGET",
        message: "Locked order target was not provided to CreateShipment.",
      });
    }

    assertReadyToShipWithAssignee({ target, ctx });
    await assertShippingAssignee({ tx, target, ctx });

    const existing = await tx.shipment.findFirst({
      where: { organizationId: ctx.organizationId, orderId: target.id },
      select: { id: true },
    });
    if (existing !== null) {
      throw new errors.ConflictError({
        code: SHIPMENT_ALREADY_EXISTS,
        message: "A shipment already exists for this order.",
        metadata: { orderId: target.id, shipmentId: existing.id },
      });
    }

    const shipment = await tx.shipment.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        siteId: target.siteId,
        status: ShipmentStatus.CREATED,
        carrier: input.carrier,
        serviceLevel: input.serviceLevel,
        trackingNumber: input.trackingNumber,
        externalShipmentId: input.externalShipmentId ?? null,
        externalTrackerId: input.externalTrackerId ?? null,
        createdByUserId: ctx.actor.userId,
        createCommandLogId: commandLogId,
      },
      select: { id: true },
    });

    const now = clock.now();
    const toVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        shipmentId: shipment.id,
        trackingNumber: input.trackingNumber,
        version: toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: toVersion },
      audit: {
        action: "order.shipment.created",
        resourceType: "Shipment",
        resourceId: shipment.id,
        metadata: {
          orderId: target.id,
          shipmentId: shipment.id,
          carrier: input.carrier,
          serviceLevel: input.serviceLevel,
          trackingNumber: input.trackingNumber,
          hasExternalShipmentId: input.externalShipmentId !== undefined,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.shipment.created.v1",
          aggregateType: "Shipment",
          aggregateId: shipment.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            shipmentId: shipment.id,
            carrier: input.carrier,
            serviceLevel: input.serviceLevel,
            trackingNumber: input.trackingNumber,
            createdByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH, SHIP_NOT_ASSIGNED_TO_ACTOR, SHIP_WRONG_STATUS };
