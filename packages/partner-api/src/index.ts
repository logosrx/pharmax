// Public surface of @pharmax/partner-api (ADR-0032).
//
// The platform's partner-facing bounded context: API key credential
// primitives + resolution, the four admin commands, and the outbound
// webhook fan-out / signing / delivery machinery.

export {
  API_KEY_TOKEN_PREFIX,
  WEBHOOK_SECRET_PREFIX,
  generateApiKeyToken,
  generateWebhookSecret,
  hashApiKeyToken,
  isWellFormedApiKeyToken,
  type GeneratedApiKeyToken,
} from "./api-key/token.js";

export {
  API_KEY_QUOTA_TIERS,
  API_KEY_QUOTA_TIER_NAMES,
  getApiKeyQuota,
  isApiKeyQuotaTier,
  type ApiKeyQuota,
  type ApiKeyQuotaRule,
} from "./api-key/quota.js";

export {
  resolveApiKey,
  RESOLVE_API_KEY_MALFORMED,
  RESOLVE_API_KEY_NOT_FOUND,
  RESOLVE_API_KEY_REVOKED,
  type ResolveApiKeyClient,
  type ResolveApiKeyFailure,
  type ResolveApiKeyResult,
  type ResolvedApiKey,
} from "./api-key/resolve-api-key.js";

export {
  CreateApiKey,
  CREATE_API_KEY_UNKNOWN_SCOPE,
  CREATE_API_KEY_HASH_COLLISION,
  type CreateApiKeyInput,
  type CreateApiKeyOutput,
} from "./commands/create-api-key.js";

export {
  RevokeApiKey,
  REVOKE_API_KEY_NOT_FOUND,
  REVOKE_API_KEY_ALREADY_REVOKED,
  type RevokeApiKeyInput,
  type RevokeApiKeyOutput,
} from "./commands/revoke-api-key.js";

export {
  CreateWebhookSubscription,
  CREATE_WEBHOOK_SUBSCRIPTION_DUPLICATE_ENDPOINT,
  CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT,
  CREATE_WEBHOOK_SUBSCRIPTION_URL_HAS_CREDENTIALS,
  CREATE_WEBHOOK_SUBSCRIPTION_URL_NON_DEFAULT_PORT,
  CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS,
  CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_PUBLIC,
  CREATE_WEBHOOK_SUBSCRIPTION_URL_UNPARSEABLE,
  type CreateWebhookSubscriptionInput,
  type CreateWebhookSubscriptionOutput,
} from "./commands/create-webhook-subscription.js";

export {
  RevokeWebhookSubscription,
  REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND,
  REVOKE_WEBHOOK_SUBSCRIPTION_ALREADY_DISABLED,
  type RevokeWebhookSubscriptionInput,
  type RevokeWebhookSubscriptionOutput,
} from "./commands/revoke-webhook-subscription.js";

export {
  RotateWebhookSubscriptionSecret,
  ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND,
  ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED,
  type RotateWebhookSubscriptionSecretInput,
  type RotateWebhookSubscriptionSecretOutput,
} from "./commands/rotate-webhook-subscription-secret.js";

export {
  WEBHOOK_ELIGIBLE_EVENT_TYPES,
  isWebhookEligibleEventType,
  listWebhookEligibleEventTypes,
} from "./webhooks/eligible-events.js";

export {
  classifyWebhookEndpoint,
  type WebhookEndpointAccepted,
  type WebhookEndpointRejected,
  type WebhookEndpointRejection,
  type WebhookEndpointVerdict,
} from "./webhooks/endpoint-url.js";

export {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type SignWebhookPayloadInput,
  type VerifyWebhookSignatureInput,
} from "./webhooks/signature.js";

export {
  fanOutWebhookDeliveries,
  type FanOutClient,
  type FanOutResult,
  type FanOutSourceEvent,
} from "./webhooks/fan-out.js";

export {
  attemptWebhookDelivery,
  webhookSecretBinding,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_USER_AGENT,
  type AttemptWebhookDeliveryInput,
  type AttemptWebhookDeliveryResult,
} from "./webhooks/deliver.js";

import * as createApiKeyModule from "./commands/create-api-key.js";
import * as revokeApiKeyModule from "./commands/revoke-api-key.js";
import * as createWebhookSubscriptionModule from "./commands/create-webhook-subscription.js";
import * as revokeWebhookSubscriptionModule from "./commands/revoke-webhook-subscription.js";
import * as rotateWebhookSubscriptionSecretModule from "./commands/rotate-webhook-subscription-secret.js";

export const partnerApi = {
  commands: {
    CreateApiKey: createApiKeyModule.CreateApiKey,
    RevokeApiKey: revokeApiKeyModule.RevokeApiKey,
    CreateWebhookSubscription: createWebhookSubscriptionModule.CreateWebhookSubscription,
    RevokeWebhookSubscription: revokeWebhookSubscriptionModule.RevokeWebhookSubscription,
    RotateWebhookSubscriptionSecret:
      rotateWebhookSubscriptionSecretModule.RotateWebhookSubscriptionSecret,
  },
} as const;
