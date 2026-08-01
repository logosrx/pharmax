// POST /api/ops/admin/webhooks/revoke
//
// Admin action: disable a partner webhook subscription. Dispatches
// `RevokeWebhookSubscription` (RBAC `webhooks.manage` enforced by
// the command; MFA floor enforced by the wrapper). Disabling stops
// egress immediately — fan-out skips DISABLED subscriptions and the
// delivery drain DEAD-letters their in-flight rows — so this is the
// operator's kill switch for a compromised or offboarded receiver.
//
// Standard redirect+flash flow: no secret is involved in a revoke.

import { RevokeWebhookSubscription } from "@pharmax/partner-api";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: RevokeWebhookSubscription,
    idempotencyKeyPrefix: "route:revoke-webhook-subscription",
    buildInput: ({ body }) => {
      const subscriptionId = readString(body, "subscriptionId");
      if (subscriptionId === null || !UUID_REGEX.test(subscriptionId)) {
        return { error: "subscriptionId is required." };
      }
      const reason = readString(body, "reason");
      if (reason === null) return { error: "A reason is required to revoke a subscription." };
      return { subscriptionId, reason };
    },
    successRedirect: (output) =>
      `/ops/admin/webhooks?flash=${encodeURIComponent(
        `Subscription for ${output.url} disabled. In-flight deliveries are dead-lettered.`
      )}`,
    failureRedirect: "/ops/admin/webhooks",
    successLogEvent: "ops.admin.webhook_subscription.revoke.applied",
    failureLogEvent: "ops.admin.webhook_subscription.revoke.failed",
  });
}
