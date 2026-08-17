// ai.typing_suggestion.accepted.v1 — a technician accepted one
// field-level typing suggestion and the prescription row was updated.
//
// Producer: `AcceptTypingSuggestion` (`@pharmax/typing-assist`).
// Consumers: reporting (suggestion acceptance rates by source/field —
//   the model's report card), order timeline.
//
// The payload names the FIELD but not the values: before/after values
// live in the audit log where access is gated. Aggregate is the ORDER
// (not the suggestion) so the acceptance lands on the order's
// timeline via order_event writeback.
//
// PHI: ids, field name, source, actor, timestamp — no values.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    suggestionId: z.uuid(),
    runId: z.uuid(),
    organizationId: z.uuid(),
    orderId: z.uuid(),
    prescriptionId: z.uuid(),
    source: z.enum(["DETERMINISTIC", "MODEL"]),
    field: z.string().min(1).max(64),
    acceptedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiTypingSuggestionAcceptedV1 = defineEvent({
  name: "ai.typing_suggestion.accepted",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "ai.typing_suggestions",
  description:
    "Emitted by AcceptTypingSuggestion after a technician accepted one field-level typing proposal and the prescription row was updated under the order lock. Field name only — before/after values live in the audit log. Feeds acceptance-rate reporting (the model's report card) and the order timeline.",
});

export type AiTypingSuggestionAcceptedV1Payload = z.infer<typeof payloadSchema>;
