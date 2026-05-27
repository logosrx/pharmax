// order.held.v1 — supervisor placed an order ON_HOLD.
//
// Producer: `PlaceHold` (`@pharmax/orders`).
// Consumers: SLA timer (closes the open active interval / opens
//   HOLD_ACTIVE); hold-expiry-reminder scheduler; team-level
//   notification when the held duration crosses an SLA window.
//
// PHI: none. Free-text reason note is PHI-bearing and lives on
// the encrypted `order_hold.reasonText` column; only the
// `hasReasonText` boolean appears in the payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const HOLD_REASONS = [
  "WAITING_FOR_PROVIDER",
  "WAITING_FOR_PATIENT",
  "WAITING_FOR_INSURANCE",
  "INVENTORY_BACKORDER",
  "PRESCRIPTION_AMBIGUITY",
  "COMPLIANCE_REVIEW",
  "DUPLICATE_INVESTIGATION",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    holdId: z.uuid(),
    reason: z.enum(HOLD_REASONS),
    /**
     * `true` when the placer left a free-text reason note. The
     * text itself is encrypted on the `order_hold` row.
     */
    hasReasonText: z.boolean(),
    heldByUserId: z.uuid(),
    /**
     * Status the order was IN before the hold fired. Captured
     * before the status flip so `ReleaseHold` can read it from
     * the row to restore the right state.
     */
    heldFromStatus: z.string().min(1),
    transitionId: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderHeldV1 = defineEvent({
  name: "order.held",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by PlaceHold after a supervisor parks the order in ON_HOLD. Closes the open active SLA interval and opens HOLD_ACTIVE; drives the hold-expiry-reminder loop.",
});

export type OrderHeldV1Payload = z.infer<typeof payloadSchema>;
