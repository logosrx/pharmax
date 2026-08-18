// ai.typing_suggestion.dismissed.v1 — a technician declined one
// field-level typing suggestion with a structured reason.
//
// Producer: `DismissTypingSuggestion` (`@pharmax/typing-assist`).
// Consumers: reporting — dismiss reasons are the negative half of the
//   model's report card ("dismissed as wrong" vs "fixed manually" are
//   opposite quality signals), and a rising wrong-suggestion rate for
//   a product is the operational trigger for tightening its guardrail
//   or disabling its AI surface.
//
// PHI: ids, field name, source, reason code, actor, timestamp.

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
    dismissReasonCode: z.string().min(1).max(64),
    dismissedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiTypingSuggestionDismissedV1 = defineEvent({
  name: "ai.typing_suggestion.dismissed",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "ai.typing_suggestions",
  description:
    "Emitted by DismissTypingSuggestion when a technician declines a typing proposal with a structured reason code. Dismiss reasons feed the negative half of suggestion-quality reporting and are the operational trigger for tightening a product guardrail or disabling its AI surface.",
});

export type AiTypingSuggestionDismissedV1Payload = z.infer<typeof payloadSchema>;
