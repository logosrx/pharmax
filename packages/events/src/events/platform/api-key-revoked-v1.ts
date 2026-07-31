// platform.api_key.revoked.v1 — a partner API key was revoked.
//
// Producer: `RevokeApiKey` (`@pharmax/partner-api`).
// Consumers: security feed; incident-response evidence ("when was
//   the leaked key cut off?").
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    apiKeyId: z.uuid(),
    tokenPrefix: z.string().min(4).max(16),
    reason: z.string().min(1).max(500),
    revokedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PlatformApiKeyRevokedV1 = defineEvent({
  name: "platform.api_key.revoked",
  version: 1,
  aggregateType: "ApiKey",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.apiKeyId,
  owner: "platform",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by RevokeApiKey after a partner API key is marked REVOKED with a reason. Anchors the incident-response timeline for credential cutoff.",
});

export type PlatformApiKeyRevokedV1Payload = z.infer<typeof payloadSchema>;
