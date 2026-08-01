// Platform-domain event definitions (ADR-0032): partner API keys +
// outbound webhook subscriptions.

export {
  PlatformApiKeyCreatedV1,
  type PlatformApiKeyCreatedV1Payload,
} from "./api-key-created-v1.js";
export {
  PlatformApiKeyRevokedV1,
  type PlatformApiKeyRevokedV1Payload,
} from "./api-key-revoked-v1.js";
export {
  PlatformWebhookSubscriptionCreatedV1,
  type PlatformWebhookSubscriptionCreatedV1Payload,
} from "./webhook-subscription-created-v1.js";
export {
  PlatformWebhookSubscriptionRevokedV1,
  type PlatformWebhookSubscriptionRevokedV1Payload,
} from "./webhook-subscription-revoked-v1.js";
export {
  PlatformWebhookSubscriptionSecretRotatedV1,
  type PlatformWebhookSubscriptionSecretRotatedV1Payload,
} from "./webhook-subscription-secret-rotated-v1.js";
