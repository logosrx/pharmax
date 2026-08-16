// catalog.compound_product.created.v1 — an in-house compound product
// was added to the org's catalog: the Product row exists with
// `ndcKind = IN_HOUSE_COMPOUND`, a freshly minted Pharmax Product ID
// (mirrored into `ndc` as the org-local identifier), and the frozen
// serial identity that every batch unit number of this product will
// carry.
//
// Producer: `CreateCompoundProduct` (`@pharmax/inventory`).
// Consumers: catalog projections/counters; the future compound-batch
//   surface (batch creation lists compounds by this id); reporting.
//
// PHI-safe: catalog data only (product identity, strength, serial
// identity). No patient linkage exists at creation time.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    productId: z.uuid(),
    /** Minted catalog id, e.g. "PXP-000042". Also stored in `ndc`. */
    pharmaxProductId: z.string(),
    name: z.string(),
    /** Display strength, e.g. "10mg/20mg/3mL". */
    strength: z.string(),
    /** Counting unit for batches (VIAL, TABLET, ...). */
    unitKind: z.string(),
    /** Serial identity: first letter of the primary drug ("T"). */
    serialDrugInitial: z.string(),
    /** Serial identity: total mg of the primary drug per container. */
    serialDrugMg: z.number().int().positive(),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CatalogCompoundProductCreatedV1 = defineEvent({
  name: "catalog.compound_product.created",
  version: 1,
  aggregateType: "Product",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.productId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "catalog.product",
  description:
    "Emitted by CreateCompoundProduct when an in-house compound product is added to the catalog with its minted Pharmax Product ID and frozen serial identity (primary-drug initial + mg). The id is the anchor every compound batch and batch label of this product will reference.",
});

export type CatalogCompoundProductCreatedV1Payload = z.infer<typeof payloadSchema>;
