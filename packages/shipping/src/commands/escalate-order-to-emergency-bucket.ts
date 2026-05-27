// EscalateOrderToEmergencyBucket — move an order into the
// EMERGENCY bucket because something has gone wrong with shipping.
//
// Triggered by the `shipment.tracking.recorded.v1` outbox handler
// when the recorded `kind` is `EXCEPTION`, `FAILED_DELIVERY`, or
// `RETURN_TO_SENDER` (see `apps/worker/src/drains/outbox-handlers.ts`).
//
// What this command does:
//   1. Lock the order row.
//   2. Resolve the org's `EMERGENCY` bucket by code (seeded by
//      `ProvisionDefaultBuckets`).
//   3. If the order is already in EMERGENCY, write the audit row
//      and a `noop` outbox event so the timeline still records
//      "tracking-event X reaffirmed the escalation" but do NOT
//      mutate the order — repeated EXCEPTION events for the same
//      shipment must not re-bump the version every time, or
//      concurrent commands lose CAS races constantly.
//   4. Otherwise: CAS the order's `currentBucketId = EMERGENCY.id`
//      (version bumped), emit `order.escalated_to_emergency.v1`.
//
// What this command does NOT do:
//   - Mutate `currentStatus`. The order keeps the workflow state
//     it died in (typically `SHIPPED`). The bucket move is an
//     OPERATIONAL signal, not a workflow transition.
//   - Move the order BACK out of EMERGENCY. That's the shipping
//     clerk's job (a separate `ResolveShipmentException` command
//     in a future slice — for now the operator manually re-buckets
//     once the issue is dispositioned).
//
// Idempotency: the caller (outbox handler) keys on
// `"escalate:{shipmentId}:{externalEventId}"` so the bus
// short-circuits a re-delivery of the same tracking event before
// we even hit the DB. The "already in EMERGENCY" branch inside
// this command is the second line of defense.
//
// PHI invariant: no PHI is read or written here. The triggering
// tracking event may have included recipient address in its
// raw payload, but that's stored on the `shipment_tracking_event`
// row, not propagated through this command's audit / outbox.

import { defineCommand, type OutboxEventDraft } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const ESCALATE_ORDER_BUCKET_NOT_CONFIGURED = "ESCALATE_ORDER_BUCKET_NOT_CONFIGURED";
export const ESCALATE_ORDER_VERSION_MISMATCH = "ESCALATE_ORDER_VERSION_MISMATCH";

const EMERGENCY_BUCKET_CODE = "EMERGENCY";

export const ESCALATION_REASONS = ["EXCEPTION", "FAILED_DELIVERY", "RETURN_TO_SENDER"] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

const inputSchema = z
  .object({
    orderId: z.uuid(),
    /**
     * The shipment whose tracking event triggered the escalation.
     * Stored on the audit row so the order timeline can backlink
     * to the originating shipment.
     */
    shipmentId: z.uuid(),
    /**
     * The internal `shipment_tracking_event.id` for the row that
     * fired the escalation. Together with `externalEventId` this
     * fully identifies the carrier event.
     */
    trackingEventId: z.uuid(),
    /**
     * Carrier-supplied event id (e.g. EasyPost tracker update id,
     * synthetic `fedex:{trackingNumber}:{code}:{occurredAt}` for
     * the FedEx + UPS pollers). Part of the bus idempotency key.
     */
    externalEventId: z.string().min(1).max(128),
    reason: z.enum(ESCALATION_REASONS),
    /** Original carrier status code (e.g. EasyPost `failure`, FedEx `DE`). */
    carrierStatus: z.string().min(1).max(64),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type EscalateOrderToEmergencyBucketInput = z.infer<typeof inputSchema>;

export interface EscalateOrderToEmergencyBucketOutput {
  readonly orderId: string;
  readonly bucketId: string;
  readonly alreadyEscalated: boolean;
  /** `null` when `alreadyEscalated === true`. */
  readonly previousBucketId: string | null;
  readonly version: number;
}

export const EscalateOrderToEmergencyBucket = defineCommand<
  EscalateOrderToEmergencyBucketInput,
  EscalateOrderToEmergencyBucketOutput
>({
  name: "EscalateOrderToEmergencyBucket",
  inputSchema,
  permission: PERMISSIONS.SHIP_ESCALATE_TO_EMERGENCY,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "ESCALATE_ORDER_NO_TARGET",
        message: "Locked target was not provided to EscalateOrderToEmergencyBucket handler.",
      });
    }

    const bucket = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: ctx.organizationId,
          code: EMERGENCY_BUCKET_CODE,
        },
      },
      select: { id: true, siteId: true },
    });
    if (bucket === null) {
      // ProvisionDefaultBuckets seeds this row for every org at
      // creation. A missing row means the org was bootstrapped
      // outside that path; fail loud so the operator runs the
      // provisioning backfill rather than silently swallowing
      // the escalation.
      throw new errors.InternalError({
        code: ESCALATE_ORDER_BUCKET_NOT_CONFIGURED,
        message: `EMERGENCY bucket is not provisioned for this organization. Run ProvisionDefaultBuckets.`,
        metadata: { organizationId: ctx.organizationId },
      });
    }

    const occurredAt = new Date(input.occurredAt);
    const now = clock.now();

    // ---- Already-in-EMERGENCY branch ----
    // We still write an audit row + outbox event so the timeline
    // shows every reaffirming carrier event. The output flags
    // `alreadyEscalated: true` so the caller can decide whether
    // to log differently.
    if (bucket.id === target.currentBucketId) {
      return {
        output: {
          orderId: target.id,
          bucketId: bucket.id,
          alreadyEscalated: true,
          previousBucketId: null,
          version: target.version,
        },
        targetOrderId: target.id,
        audit: {
          action: "order.shipment_escalation_reaffirmed",
          resourceType: "Order",
          resourceId: target.id,
          metadata: {
            orderId: target.id,
            shipmentId: input.shipmentId,
            trackingEventId: input.trackingEventId,
            externalEventId: input.externalEventId,
            reason: input.reason,
            carrierStatus: input.carrierStatus,
            occurredAt: occurredAt.toISOString(),
            recordedAt: now.toISOString(),
            commandLogId,
          },
        },
        emits: [reaffirmEvent(target.id, ctx.organizationId, input, occurredAt, now)],
      };
    }

    // ---- First-time escalation branch ----
    const previousBucketId = target.currentBucketId;
    const nextVersion = target.version + 1;

    await tx.order.update({
      where: { id: target.id },
      data: { currentBucketId: bucket.id },
    });

    return {
      output: {
        orderId: target.id,
        bucketId: bucket.id,
        alreadyEscalated: false,
        previousBucketId,
        version: nextVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.escalated_to_emergency",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          shipmentId: input.shipmentId,
          trackingEventId: input.trackingEventId,
          externalEventId: input.externalEventId,
          reason: input.reason,
          carrierStatus: input.carrierStatus,
          previousBucketId,
          newBucketId: bucket.id,
          occurredAt: occurredAt.toISOString(),
          recordedAt: now.toISOString(),
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.escalated_to_emergency.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            shipmentId: input.shipmentId,
            trackingEventId: input.trackingEventId,
            externalEventId: input.externalEventId,
            reason: input.reason,
            carrierStatus: input.carrierStatus,
            previousBucketId,
            newBucketId: bucket.id,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
});

function reaffirmEvent(
  orderId: string,
  organizationId: string,
  input: EscalateOrderToEmergencyBucketInput,
  occurredAt: Date,
  recordedAt: Date
): OutboxEventDraft {
  return {
    eventType: "order.shipment_escalation_reaffirmed.v1",
    aggregateType: "Order",
    aggregateId: orderId,
    payload: {
      orderId,
      organizationId,
      shipmentId: input.shipmentId,
      trackingEventId: input.trackingEventId,
      externalEventId: input.externalEventId,
      reason: input.reason,
      carrierStatus: input.carrierStatus,
      occurredAt: occurredAt.toISOString(),
      recordedAt: recordedAt.toISOString(),
    },
  };
}
