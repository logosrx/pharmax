// ai.typing_suggestion_run.requested.v1 — a technician requested an
// AI typing-assist evaluation and the phase-1 gate permitted the
// model stage.
//
// Producer: `RequestTypingSuggestions` (`@pharmax/typing-assist`).
//   Emitted ONLY when modelSuggestionsPermitted was true — a gated-off
//   run terminates synchronously as MODEL_SKIPPED and produces no
//   event, so this event's existence is itself the audited "the model
//   was allowed to see this draft" moment.
// Consumer: the worker's typing-suggestion drain (LOAD-BEARING — a
//   requested run with no consumer would sit PENDING_MODEL forever, so
//   this event type is in REQUIRED_HANDLER_EVENT_TYPES).
//
// PHI: ids, revision pins, timestamps only. The draft content the
// model will see is re-read from the database by the worker under
// tenancy context — it never rides the event.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    runId: z.uuid(),
    organizationId: z.uuid(),
    orderId: z.uuid(),
    prescriptionId: z.uuid(),
    requestedByUserId: z.uuid(),
    /** ai_assist_policy revision pinned on the run (null = no row). */
    policyVersion: z.number().int().positive().nullable(),
    /** product_ai_guardrail revision pinned on the run (null = none). */
    guardrailVersion: z.number().int().positive().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiTypingSuggestionRunRequestedV1 = defineEvent({
  name: "ai.typing_suggestion_run.requested",
  version: 1,
  aggregateType: "TypingSuggestionRun",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.runId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "ai.typing_suggestions",
  description:
    "Emitted by RequestTypingSuggestions when the org policy + product guardrail gate permits the model stage for a typing draft. The worker consumes it to run the Bedrock call; a run with a closed gate never produces this event. Load-bearing consumer — registered in REQUIRED_HANDLER_EVENT_TYPES.",
});

export type AiTypingSuggestionRunRequestedV1Payload = z.infer<typeof payloadSchema>;
