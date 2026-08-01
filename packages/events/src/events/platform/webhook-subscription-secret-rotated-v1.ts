// platform.webhook_subscription.secret_rotated.v1 — a subscription's
// HMAC signing secret was rotated in place.
//
// Producer: `RotateWebhookSubscriptionSecret` (`@pharmax/partner-api`).
// Consumers: security feed (credential rotation on an egress channel
//   is security-relevant); SOC 2 key-management evidence.
//
// PHI: none. Neither the OLD nor the NEW secret appears in any
// event — this records THAT a rotation happened, never the material.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    subscriptionId: z.uuid(),
    /** Partner endpoint (HTTPS). Infrastructure metadata, not PHI. */
    url: z.url(),
    rotatedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PlatformWebhookSubscriptionSecretRotatedV1 = defineEvent({
  name: "platform.webhook_subscription.secret_rotated",
  version: 1,
  aggregateType: "WebhookSubscription",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.subscriptionId,
  owner: "platform",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by RotateWebhookSubscriptionSecret after a subscription's envelope-encrypted HMAC signing secret is replaced in place. Rotation of an egress-signing credential belongs in the security-review trail; the secret material itself never appears in any event.",
});

export type PlatformWebhookSubscriptionSecretRotatedV1Payload = z.infer<typeof payloadSchema>;
