// order.sla_breach_escalated.v1 — order moved into EMERGENCY because it blew its SLA deadline.
//
// Producer: `EscalateOrderForSlaBreach` (`@pharmax/orders`),
//   dispatched by the worker SLA breach-evaluator tick
//   (`apps/worker/src/drains/sla-breach-evaluator.ts`).
// Consumers: emergency-queue counter; ops-lead SLA-breach alert;
//   SLA-breach reporting rollups.
//
// PHI: none — order id + bucket ids + SLA timestamps only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    /** The end-to-end SLA deadline the order blew. */
    slaDeadlineAt: z.iso.datetime({ offset: true }),
    /** When the evaluator observed the breach (the tick's `now`). */
    breachedAt: z.iso.datetime({ offset: true }),
    /** Bucket the order was IN before escalation. */
    previousBucketId: z.uuid(),
    /** The EMERGENCY bucket the order moves INTO. */
    newBucketId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderSlaBreachEscalatedV1 = defineEvent({
  name: "order.sla_breach_escalated",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by EscalateOrderForSlaBreach when the worker breach-evaluator routes an SLA-breached order into the EMERGENCY bucket. Drives the ops-lead alert + emergency-queue counter + SLA reporting.",
});

export type OrderSlaBreachEscalatedV1Payload = z.infer<typeof payloadSchema>;
