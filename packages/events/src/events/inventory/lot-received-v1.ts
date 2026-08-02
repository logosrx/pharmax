// inventory.lot.received.v1 — an inbound lot shipment was received:
// the Lot row exists (created or extended), the inventory ledger was
// credited with LOT_RECEIVED, and the DSCSA transaction record
// (TI snapshot + Transaction Statement gate) was stored.
//
// Producer: `ReceiveLot` (`@pharmax/inventory`).
// Consumers: inventory projections/counters; recall-response tooling
//   (receipt is the inbound anchor of a lot's chain of custody).
//
// PHI-safe: supply-chain identity only (lot/product ids, lot number,
// quantity). Seller/buyer names and addresses stay on the row.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    dscsaTransactionId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    lotId: z.uuid(),
    productId: z.uuid(),
    lotNumber: z.string(),
    /** Quantity credited to the ledger by this receipt. */
    quantity: z.number().positive(),
    /** True when this receipt created the Lot row (first arrival of
     *  this (site, product, lotNumber)); false when it extended an
     *  existing lot. */
    lotCreated: z.boolean(),
    receivedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InventoryLotReceivedV1 = defineEvent({
  name: "inventory.lot.received",
  version: 1,
  aggregateType: "Lot",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.lotId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "inventory.lot",
  description:
    "Emitted by ReceiveLot when an inbound lot shipment is received with its DSCSA transaction record (ADR-0035 slice 3). The receipt is the inbound anchor of the lot's chain of custody.",
});

export type InventoryLotReceivedV1Payload = z.infer<typeof payloadSchema>;
