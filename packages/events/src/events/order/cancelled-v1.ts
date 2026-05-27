// order.cancelled.v1 — operator cancelled the order.
//
// Producer: `CancelOrder` (`@pharmax/orders`).
// Consumers: SLA timer (closes any open interval and marks the
//   order TERMINAL), billing reconciliation.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    cancellationId: z.uuid(),
    dispositionReason: z.string().min(1).max(64),
    /**
     * Boolean flag — true when the operator left a free-text
     * `reasonText`. The text itself stays out of the payload
     * because it may carry PHI; consumers that need the text can
     * read it from the `order_cancellation` row, scoped by tenancy.
     */
    hasReasonText: z.boolean(),
    cancelledByUserId: z.uuid(),
    cancelledFromStatus: z.string().min(1),
    transitionId: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderCancelledV1 = defineEvent({
  name: "order.cancelled",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by CancelOrder. Carries the disposition reason and a hasReasonText flag — the actual reason text is PHI-redacted out of the payload.",
});

export type OrderCancelledV1Payload = z.infer<typeof payloadSchema>;
