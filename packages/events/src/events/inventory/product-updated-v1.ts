// inventory.product.updated.v1 — a catalog product's descriptive
// fields or screening-relevant switches changed.
//
// Producer: `UpdateProduct` (`@pharmax/inventory`).
// Consumers: catalog projections; admin activity feed. The
//   before/after values of the screening-relevant switches live in
//   the AUDIT row, not here — this event announces that a change
//   happened and what the current values are; the audit trail is
//   the forensic record.
//
// PHI: none. Catalog identity only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const NDC_KINDS = ["NATIONAL", "IN_HOUSE_COMPOUND"] as const;
const SCHEDULES = ["NON_CONTROLLED", "CII", "CIII", "CIV", "CV"] as const;

const payloadSchema = z
  .object({
    productId: z.uuid(),
    organizationId: z.uuid(),
    /** Which draft fields actually changed (no-op updates are refused
     *  by the command, so this is always non-empty). */
    changedFields: z.array(z.string().min(1)).min(1),
    ndcKind: z.enum(NDC_KINDS),
    controlledSubstanceSchedule: z.enum(SCHEDULES),
    updatedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InventoryProductUpdatedV1 = defineEvent({
  name: "inventory.product.updated",
  version: 1,
  aggregateType: "Product",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.productId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "inventory.product",
  description:
    "Emitted by UpdateProduct after a catalog product edit. changedFields names what moved; the post-change ndcKind and controlledSubstanceSchedule are carried because both alter downstream screening behavior. Before/after forensics live in the audit row.",
});

export type InventoryProductUpdatedV1Payload = z.infer<typeof payloadSchema>;
