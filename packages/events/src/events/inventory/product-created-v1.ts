// inventory.product.created.v1 — a drug product was added to the
// org's catalog through the gated CRUD surface.
//
// Producer: `CreateProduct` (`@pharmax/inventory`).
// Consumers: catalog projections/counters; admin activity feed;
//   (later-phase) typing-assist tooling that prompts for a guardrail
//   on newly created products.
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
    ndc: z.string().min(1).max(60),
    ndcKind: z.enum(NDC_KINDS),
    controlledSubstanceSchedule: z.enum(SCHEDULES),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InventoryProductCreatedV1 = defineEvent({
  name: "inventory.product.created",
  version: 1,
  aggregateType: "Product",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.productId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "inventory.product",
  description:
    "Emitted by CreateProduct when a drug product is added to the org's catalog (typing-assist phase 1 CRUD surface). Carries the two screening-relevant switches (ndcKind, controlledSubstanceSchedule) so consumers can react to catalog composition without a read.",
});

export type InventoryProductCreatedV1Payload = z.infer<typeof payloadSchema>;
