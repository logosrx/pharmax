// POST /api/v1/webhook-subscriptions/{id}/rotate-secret — rotate a
// subscription's HMAC signing secret in place (ADR-0032 follow-up).
//
// Auth: partner API key (Bearer). Scope: `webhooks.manage`.
// Requires `Idempotency-Key`.
//
// Secret contract mirrors subscription creation: the NEW raw `pxw_`
// secret is generated HERE at the transport layer, only its
// ciphertext envelope is persisted (the command input is redacted),
// and it is returned in this response EXACTLY ONCE. Replays of the
// same Idempotency-Key return the stored command output WITHOUT the
// secret — a replay cannot re-disclose it.
//
// Cut-over: single-secret v1. Install the returned secret on the
// receiver immediately; every delivery attempt after this call —
// including retries of older failed deliveries — is signed with it.

import { executeCommandDetailed } from "@pharmax/command-bus";
import { generateWebhookSecret, RotateWebhookSubscriptionSecret } from "@pharmax/partner-api";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import {
  partnerJsonError,
  requireIdempotencyKeyHeader,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../../../src/server/partner/resolve-partner-context.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> }
): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.WEBHOOKS_MANAGE);
  if (denied !== null) return denied;
  const idem = requireIdempotencyKeyHeader(request);
  if (!idem.ok) return idem.response;

  const { subscriptionId } = await params;
  if (!UUID_REGEX.test(subscriptionId)) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_SUBSCRIPTION_ID",
      message: "subscriptionId must be a UUID.",
    });
  }

  // Generated fresh on every attempt; the command declares
  // `hashExcludeFields: ["secret"]` so a retry under the same
  // Idempotency-Key hash-matches and replays. On a replay the
  // ORIGINALLY-stored secret is the active one — this fresh value
  // was never stored and must be discarded, never surfaced.
  const secret = generateWebhookSecret();

  try {
    const { output, replayed } = await withTenancyContext(resolved.context.tenancy, () =>
      executeCommandDetailed(
        RotateWebhookSubscriptionSecret,
        { subscriptionId, secret },
        { idempotencyKey: `partner:${resolved.context.key.apiKeyId}:${idem.key}` }
      )
    );
    return NextResponse.json({
      data: { ...output, secret: replayed ? null : secret },
      ...(replayed ? { meta: { idempotentReplay: true } } : {}),
    });
  } catch (cause) {
    if (cause instanceof errors.PharmaxError) {
      const status = cause.code === "ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND" ? 404 : 422;
      return partnerJsonError({ status, code: cause.code, message: cause.message });
    }
    throw cause;
  }
}
