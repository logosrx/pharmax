// platform.api_key.created.v1 — a partner API key was minted.
//
// Producer: `CreateApiKey` (`@pharmax/partner-api`).
// Consumers: security feed; SOC 2 access-review evidence (a minted
//   key is a standing credential and belongs in the review trail).
//
// PHI: none. Key metadata only — the raw token NEVER appears in any
// event (only its display prefix does).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    apiKeyId: z.uuid(),
    /** Operator-facing label. Not secret. */
    name: z.string().min(1).max(120),
    /** Display prefix (e.g. `pxk_3fA9`) — NOT the token. */
    tokenPrefix: z.string().min(4).max(16),
    /** Permission codes the key may exercise. */
    scopes: z.array(z.string().min(1).max(128)).max(200),
    /**
     * Named quota tier (ADR-0032). Optional because events emitted
     * before tiers existed have no tier — absent means STANDARD.
     */
    quotaTier: z.enum(["STANDARD", "ELEVATED"]).optional(),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PlatformApiKeyCreatedV1 = defineEvent({
  name: "platform.api_key.created",
  version: 1,
  aggregateType: "ApiKey",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.apiKeyId,
  owner: "platform",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by CreateApiKey after a partner API key row (SHA-256 hash + scopes) is persisted. A minted key is a standing credential; this event anchors the security-review trail for it.",
});

export type PlatformApiKeyCreatedV1Payload = z.infer<typeof payloadSchema>;
