// RecordShipmentTrackingEvent — append a normalized carrier tracking
// event to a shipment.
//
// This command is invoked by the shipping-webhook drain after the
// inbound HTTP handler has:
//   1. Verified the carrier signature (HMAC).
//   2. Parsed the payload into our normalized shape.
//   3. Resolved the shipment via `(organizationId, externalTrackerId
//      OR trackingNumber)` and entered the org's tenancy context.
//
// Inside the command:
//   - Idempotency is enforced at two layers:
//       (a) the bus's per-command idempotency cache via
//           `idempotencyKey = "${source}:${externalEventId}"`, and
//       (b) the database unique constraint on
//           `(organizationId, source, externalEventId)`.
//     Layer (a) saves a round-trip on retries; layer (b) is the
//     correctness guarantee under concurrent webhook delivery.
//   - The shipment's cached status is advanced ONLY when the
//     incoming event is strictly newer (`occurredAt >
//     shipment.lastTrackingEventAt`) AND the normalized kind maps
//     to a non-null shipment status. Out-of-order events still
//     land in the ledger but never roll the cached status back.
//   - The order's workflow status is NOT advanced here. The order
//     transitions to SHIPPED via `ConfirmShipment`; tracking events
//     are post-shipment telemetry, not workflow drivers. A future
//     "DeliveryConfirmed" workflow command (if we add a SHIPPED →
//     DELIVERED state) would be the right place to bridge.
//
// PHI rule: tracking events are PHI-free. `rawPayload` may include
// recipient address — keep `audit.metadata` and outbox payloads to
// shipment id + carrier status + occurredAt + kind.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma, ShipmentTrackingEventKind, ShipmentTrackingSource } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { ulid } from "ulid";
import { z } from "zod";

import { shipmentStatusForTrackingKind } from "../carriers/easypost-status.js";

export const SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND = "SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND";
export const SHIPMENT_TRACKING_DUPLICATE_EVENT = "SHIPMENT_TRACKING_DUPLICATE_EVENT";

const sourceSchema = z.enum([
  ShipmentTrackingSource.EASYPOST,
  ShipmentTrackingSource.MANUAL,
  ShipmentTrackingSource.FEDEX,
  ShipmentTrackingSource.UPS,
]);

const kindSchema = z.enum([
  ShipmentTrackingEventKind.CREATED,
  ShipmentTrackingEventKind.IN_TRANSIT,
  ShipmentTrackingEventKind.OUT_FOR_DELIVERY,
  ShipmentTrackingEventKind.DELIVERED,
  ShipmentTrackingEventKind.EXCEPTION,
  ShipmentTrackingEventKind.RETURN_TO_SENDER,
  ShipmentTrackingEventKind.FAILED_DELIVERY,
  ShipmentTrackingEventKind.UNKNOWN,
]);

const inputSchema = z
  .object({
    shipmentId: z.uuid(),
    source: sourceSchema,
    externalEventId: z.string().min(1).max(128),
    kind: kindSchema,
    carrierStatus: z.string().min(1).max(64),
    carrierStatusDetail: z.string().max(128).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    signatureVerifiedAt: z.iso.datetime({ offset: true }),
    rawPayload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RecordShipmentTrackingEventInput = z.infer<typeof inputSchema>;

export interface RecordShipmentTrackingEventOutput {
  readonly trackingEventId: string;
  readonly shipmentId: string;
  readonly orderId: string;
  readonly applied: boolean;
  readonly cachedStatusAdvanced: boolean;
}

export const RecordShipmentTrackingEvent: Command<
  RecordShipmentTrackingEventInput,
  RecordShipmentTrackingEventOutput
> = {
  name: "RecordShipmentTrackingEvent",
  inputSchema,
  permission: PERMISSIONS.SHIP_RECORD_TRACKING_EVENT,
  redactFields: ["rawPayload"],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<RecordShipmentTrackingEventOutput>> {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, organizationId: ctx.organizationId },
      select: {
        id: true,
        orderId: true,
        siteId: true,
        status: true,
        lastTrackingEventAt: true,
        lastTrackingEventKind: true,
      },
    });
    if (shipment === null) {
      throw new errors.NotFoundError({
        code: SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND,
        message: "Shipment not found in this organization.",
        metadata: { shipmentId: input.shipmentId },
      });
    }

    const occurredAt = new Date(input.occurredAt);
    const signatureVerifiedAt = new Date(input.signatureVerifiedAt);

    const trackingEventId = ulid();
    try {
      await tx.shipmentTrackingEvent.create({
        data: {
          id: trackingEventId,
          organizationId: ctx.organizationId,
          shipmentId: shipment.id,
          source: input.source,
          externalEventId: input.externalEventId,
          kind: input.kind,
          carrierStatus: input.carrierStatus,
          carrierStatusDetail: input.carrierStatusDetail ?? null,
          occurredAt,
          rawPayload: input.rawPayload as Prisma.InputJsonValue,
          signatureVerifiedAt,
          commandLogId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: SHIPMENT_TRACKING_DUPLICATE_EVENT,
          message: "This carrier tracking event has already been recorded for this organization.",
          metadata: {
            shipmentId: shipment.id,
            source: input.source,
            externalEventId: input.externalEventId,
          },
        });
      }
      throw err;
    }

    const newCachedStatus = shipmentStatusForTrackingKind(input.kind);
    const isStrictlyNewer =
      shipment.lastTrackingEventAt === null ||
      occurredAt.getTime() > shipment.lastTrackingEventAt.getTime();
    const shouldAdvanceCache = newCachedStatus !== null && isStrictlyNewer;

    if (shouldAdvanceCache) {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: newCachedStatus,
          lastTrackingEventAt: occurredAt,
          lastTrackingEventKind: input.kind,
        },
      });
    } else if (isStrictlyNewer) {
      // Even an UNKNOWN/CREATED event still updates the cached
      // `lastTrackingEventAt` timestamp so the UI shows a fresh
      // heartbeat. Shipment.status stays put.
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          lastTrackingEventAt: occurredAt,
          lastTrackingEventKind: input.kind,
        },
      });
    }

    return {
      output: {
        trackingEventId,
        shipmentId: shipment.id,
        orderId: shipment.orderId,
        applied: true,
        cachedStatusAdvanced: shouldAdvanceCache,
      },
      targetOrderId: shipment.orderId,
      audit: {
        action: "shipment.tracking.recorded",
        resourceType: "Shipment",
        resourceId: shipment.id,
        metadata: {
          trackingEventId,
          shipmentId: shipment.id,
          orderId: shipment.orderId,
          siteId: shipment.siteId,
          source: input.source,
          externalEventId: input.externalEventId,
          kind: input.kind,
          carrierStatus: input.carrierStatus,
          occurredAt: occurredAt.toISOString(),
          cachedStatusAdvanced: shouldAdvanceCache,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "shipment.tracking.recorded.v1",
          aggregateType: "Shipment",
          aggregateId: shipment.id,
          payload: {
            organizationId: ctx.organizationId,
            shipmentId: shipment.id,
            orderId: shipment.orderId,
            siteId: shipment.siteId,
            source: input.source,
            // `trackingEventId` (DB row id) — surfaced so downstream
            // outbox handlers (notably `EscalateOrderToEmergencyBucket`)
            // can backlink the order-timeline entry to the originating
            // tracking-event row without a separate join.
            trackingEventId,
            externalEventId: input.externalEventId,
            kind: input.kind,
            carrierStatus: input.carrierStatus,
            occurredAt: occurredAt.toISOString(),
            cachedStatusAdvanced: shouldAdvanceCache,
          },
        },
      ],
    };
  },
};
