// platform.webhook_subscription.created.v1 — an outbound webhook
// subscription was created.
//
// Producer: `CreateWebhookSubscription` (`@pharmax/partner-api`).
// Consumers: security feed (a new egress endpoint for tenant data is
//   security-relevant); admin activity feed.
//
// PHI: none. The signing secret NEVER appears in any event.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    subscriptionId: z.uuid(),
    /** Partner endpoint (HTTPS). Infrastructure metadata, not PHI. */
    url: z.url(),
    /** Versioned registry event names this subscription receives. */
    eventTypes: z.array(z.string().min(1).max(128)).min(1).max(100),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PlatformWebhookSubscriptionCreatedV1 = defineEvent({
  name: "platform.webhook_subscription.created",
  version: 1,
  aggregateType: "WebhookSubscription",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.subscriptionId,
  owner: "platform",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by CreateWebhookSubscription after a partner endpoint + phi-safe event-type filter + envelope-encrypted signing secret are persisted. A new egress endpoint for tenant data is a security-review item.",
});

export type PlatformWebhookSubscriptionCreatedV1Payload = z.infer<typeof payloadSchema>;
