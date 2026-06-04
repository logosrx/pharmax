// order.sla_breach_escalation_reaffirmed.v1 — order already in EMERGENCY when the breach tick fired.
//
// Producer: `EscalateOrderForSlaBreach` (`@pharmax/orders`),
//   "already escalated" race-guard branch — the evaluator's claim
//   query excludes orders already in EMERGENCY, so this fires only
//   when a claim/dispatch race leaves the order parked there. No
//   bucket move; audit + this event only.
// Consumers: optional duplicate-escalation diagnostics.
//
// PHI: none — order id + SLA timestamps only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    slaDeadlineAt: z.iso.datetime({ offset: true }),
    breachedAt: z.iso.datetime({ offset: true }),
    /** When Pharmax recorded the reaffirmation. */
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderSlaBreachEscalationReaffirmedV1 = defineEvent({
  name: "order.sla_breach_escalation_reaffirmed",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by EscalateOrderForSlaBreach when a breach tick targets an order already in EMERGENCY (claim/dispatch race). Captures the repeat signal without re-moving the bucket.",
});

export type OrderSlaBreachEscalationReaffirmedV1Payload = z.infer<typeof payloadSchema>;
