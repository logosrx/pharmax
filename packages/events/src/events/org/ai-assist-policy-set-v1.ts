// ai.assist_policy.set.v1 — an org authored or revised its AI
// typing-assist policy (the master switch for model-backed
// suggestions).
//
// Producer: `SetAiAssistPolicy` (`@pharmax/typing-assist`).
// Consumers: typing-assist caches that keep the org policy hot for
//   the typing screen; admin activity feed; (later-phase) the
//   suggestion pipeline's own kill-switch watcher.
//
// Enabling a model org-wide is a governance decision, so the payload
// carries the full post-change switch state — a consumer deciding
// "may I call the model for this org?" can answer from the event
// alone without racing a read.
//
// PHI: none. Org configuration only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    policyId: z.uuid(),
    organizationId: z.uuid(),
    /** Revision number after this change (1 = first authoring). */
    version: z.number().int().positive(),
    created: z.boolean(),
    typingAssistEnabled: z.boolean(),
    minConfidencePercent: z.number().int().min(0).max(100),
    allowControlledSubstanceSuggestions: z.boolean(),
    setByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiAssistPolicySetV1 = defineEvent({
  name: "ai.assist_policy.set",
  version: 1,
  aggregateType: "AiAssistPolicy",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.policyId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by SetAiAssistPolicy when an org authors or revises its AI typing-assist policy. Typing assist is off by default; this event is the audited moment a tenant turns model-backed suggestions on or off, with the full post-change switch state.",
});

export type AiAssistPolicySetV1Payload = z.infer<typeof payloadSchema>;
