// DELETE /api/v1/webhook-subscriptions/{id} — revoke a subscription
// (ADR-0032). Disables the endpoint and DEAD-letters any in-flight
// deliveries (compromise-first semantics — see the command's notes).
//
// Auth: partner API key (Bearer). Scope: `webhooks.manage`.
// Requires `Idempotency-Key`. A `reason` may be supplied in the JSON
// body; defaults to "revoked via partner API".

import { executeCommand } from "@pharmax/command-bus";
import { RevokeWebhookSubscription } from "@pharmax/partner-api";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import {
  partnerJsonError,
  requireIdempotencyKeyHeader,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../../src/server/partner/resolve-partner-context.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
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

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason =
    typeof body["reason"] === "string" && body["reason"].trim().length > 0
      ? body["reason"].trim()
      : "revoked via partner API";

  try {
    const output = await withTenancyContext(resolved.context.tenancy, () =>
      executeCommand(
        RevokeWebhookSubscription,
        { subscriptionId, reason },
        { idempotencyKey: `partner:${resolved.context.key.apiKeyId}:${idem.key}` }
      )
    );
    return NextResponse.json({ data: output });
  } catch (cause) {
    if (cause instanceof errors.PharmaxError) {
      const status = cause.code === "REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND" ? 404 : 422;
      return partnerJsonError({ status, code: cause.code, message: cause.message });
    }
    throw cause;
  }
}
