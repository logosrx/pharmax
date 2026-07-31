// platform.webhook_subscription.revoked.v1 — an outbound webhook
// subscription was disabled.
//
// Producer: `RevokeWebhookSubscription` (`@pharmax/partner-api`).
// Consumers: security feed; admin activity feed.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    subscriptionId: z.uuid(),
    url: z.url(),
    reason: z.string().min(1).max(500),
    revokedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PlatformWebhookSubscriptionRevokedV1 = defineEvent({
  name: "platform.webhook_subscription.revoked",
  version: 1,
  aggregateType: "WebhookSubscription",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.subscriptionId,
  owner: "platform",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by RevokeWebhookSubscription after a subscription is marked DISABLED with a reason. Deliveries stop at the next fan-out; the delivery ledger is retained.",
});

export type PlatformWebhookSubscriptionRevokedV1Payload = z.infer<typeof payloadSchema>;
