// order.hold_released.v1 — supervisor released the active hold.
//
// Producer: `ReleaseHold` (`@pharmax/orders`).
// Consumers: SLA timer (closes HOLD_ACTIVE / opens the canonical
//   interval for the restored state).
//
// PHI: none. Free-text release-reason note is PHI-bearing and
// stays on the encrypted `order_hold.releaseReasonText` column;
// only the `hasReleaseReasonText` boolean appears in the payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const HOLD_RELEASE_REASONS = ["RESOLVED", "INFO_RECEIVED", "ADMIN_OVERRIDE", "OTHER"] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    holdId: z.uuid(),
    releaseReason: z.enum(HOLD_RELEASE_REASONS),
    hasReleaseReasonText: z.boolean(),
    /**
     * Original placer of the hold. Surfaced alongside the
     * releaser so reports answer "how long was order X held? by
     * whom? released by whom?" without a second row read.
     */
    heldByUserId: z.uuid(),
    releasedByUserId: z.uuid(),
    /**
     * Status the order returns to. May differ from the original
     * `heldFromStatus` when the supervisor uses the
     * release-to-state override (e.g. ADMIN_OVERRIDE rerouting).
     */
    releasedToStatus: z.string().min(1),
    transitionId: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderHoldReleasedV1 = defineEvent({
  name: "order.hold_released",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by ReleaseHold after a supervisor lifts an active hold. Closes HOLD_ACTIVE and opens the canonical SLA interval for the restored state.",
});

export type OrderHoldReleasedV1Payload = z.infer<typeof payloadSchema>;
