// order.escalation_resolved.v1 — operator routed an emergency back to a workflow queue.
//
// Producer: `ResolveOrderEscalation` (`@pharmax/shipping`),
//   RETURN_TO_SHIPPING / RETURN_TO_FILL branches.
// Consumers: SHIPMENT_ESCALATION_RESOLVED_V1 notification.
//
// PHI: none. Free-text reason note lives on the encrypted
// `order_escalation_resolution.reasonText` column.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ESCALATION_DISPOSITIONS = [
  "RETURN_TO_SHIPPING",
  "RETURN_TO_FILL",
  "KEEP_IN_EMERGENCY",
] as const;

const TARGET_BUCKET_CODES = ["SHIPPING", "FILL"] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    disposition: z.enum(ESCALATION_DISPOSITIONS),
    /** EMERGENCY bucket the order was IN. */
    previousBucketId: z.uuid(),
    /** Bucket the order moves INTO (resolved destination). */
    newBucketId: z.uuid(),
    /**
     * Canonical code of the target bucket — `SHIPPING` for
     * RETURN_TO_SHIPPING, `FILL` for RETURN_TO_FILL. Carried so
     * consumers can route without dereferencing the bucket row.
     */
    targetBucketCode: z.enum(TARGET_BUCKET_CODES),
    hasReasonText: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderEscalationResolvedV1 = defineEvent({
  name: "order.escalation_resolved",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by ResolveOrderEscalation when an operator routes an EMERGENCY-bucket order back to SHIPPING or FILL. Drives downstream rework notifications + dashboards.",
});

export type OrderEscalationResolvedV1Payload = z.infer<typeof payloadSchema>;
