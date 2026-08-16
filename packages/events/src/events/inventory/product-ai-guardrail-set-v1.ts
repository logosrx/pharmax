// inventory.product_ai_guardrail.set.v1 — a tenant authored or
// revised the AI typing-assist safety envelope for one product.
//
// Producer: `SetProductAiGuardrail` (`@pharmax/inventory`).
// Consumers: typing-assist projections/caches that keep the current
//   guardrail hot for the typing screen; admin activity feed. The
//   ceiling values themselves are read from the row (the event pins
//   the revision, not the contents).
//
// PHI: none. Product-level configuration identity only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    guardrailId: z.uuid(),
    organizationId: z.uuid(),
    productId: z.uuid(),
    /** Revision number after this change (1 = first authoring). */
    version: z.number().int().positive(),
    created: z.boolean(),
    /** Post-change state of the per-product model kill switch. */
    aiSuggestionsEnabled: z.boolean(),
    setByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InventoryProductAiGuardrailSetV1 = defineEvent({
  name: "inventory.product_ai_guardrail.set",
  version: 1,
  aggregateType: "ProductAiGuardrail",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.guardrailId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "inventory.product",
  description:
    "Emitted by SetProductAiGuardrail when a tenant authors or revises a product's AI typing-assist guardrail. The version pin lets downstream suggestion records prove which envelope they were screened against; before/after ceilings live in the audit row.",
});

export type InventoryProductAiGuardrailSetV1Payload = z.infer<typeof payloadSchema>;
