// order.reopened.v1 — supervisor reopened an order for correction.
//
// Producer: `ReopenForCorrection` (`@pharmax/orders`).
// Consumers: SLA timer (closes WAIT_AFTER_*_REJECT and opens the
//   canonical interval for the rework state); rework dashboard.
//
// PHI: none. Free-text reason note lives on the encrypted
// `order_correction_reopen.reasonText` column.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const REOPEN_REASONS = [
  "TYPING_CORRECTION",
  "PRESCRIPTION_CLARIFICATION",
  "PV1_REWORK",
  "FILL_REDO",
  "LABEL_REWORK",
  "SUPERVISOR_DIRECTED",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    correctionReopenId: z.uuid(),
    reason: z.enum(REOPEN_REASONS),
    hasReasonText: z.boolean(),
    reopenedByUserId: z.uuid(),
    /**
     * The exception state the order was IN before the reopen
     * (typically `PV1_REJECTED` or `FINAL_VERIFICATION_REJECTED`).
     */
    reopenedFromStatus: z.string().min(1),
    /**
     * The rework target state. Carried in the payload so
     * downstream rework-queue counters can route without
     * re-reading the order row.
     */
    reopenToState: z.string().min(1),
    transitionId: z.string().min(1),
    bucketId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderReopenedV1 = defineEvent({
  name: "order.reopened",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by ReopenForCorrection when a supervisor sends a PV1_REJECTED or FINAL_VERIFICATION_REJECTED order back through the workflow for rework. Carries the rework-target state.",
});

export type OrderReopenedV1Payload = z.infer<typeof payloadSchema>;
