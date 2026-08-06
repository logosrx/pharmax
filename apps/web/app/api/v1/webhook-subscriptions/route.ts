// /api/v1/webhook-subscriptions — partner webhook management (ADR-0032).
//
//   GET  — list this org's subscriptions (secret NEVER included).
//   POST — create a subscription. The `pxw_` signing secret is
//          generated HERE at the transport layer, passed to the
//          command as a redacted field, and returned in the response
//          exactly once. It is never retrievable again.
//
// Auth: partner API key (Bearer). Scope: `webhooks.manage`. The
// command bus additionally re-checks the minting user's live RBAC.
// Mutations require an `Idempotency-Key` header, namespaced per key.

import { executeCommandDetailed } from "@pharmax/command-bus";
import { readInOrgScope } from "@pharmax/database";
import {
  CreateWebhookSubscription,
  generateWebhookSecret,
  listWebhookEligibleEventTypes,
} from "@pharmax/partner-api";
import { PERMISSIONS } from "@pharmax/rbac";
import { withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import {
  partnerCommandError,
  partnerJsonError,
  requireIdempotencyKeyHeader,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../src/server/partner/resolve-partner-context.js";

export async function GET(request: Request): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.WEBHOOKS_MANAGE);
  if (denied !== null) return denied;

  const organizationId = resolved.context.key.organizationId;
  const rows = await readInOrgScope(organizationId, (tx) =>
    tx.webhookSubscription.findMany({
      where: { organizationId },
      select: {
        id: true,
        url: true,
        eventTypes: true,
        description: true,
        status: true,
        disabledAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
  );

  return NextResponse.json({
    data: rows,
    eligibleEventTypes: listWebhookEligibleEventTypes(),
  });
}

export async function POST(request: Request): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.WEBHOOKS_MANAGE);
  if (denied !== null) return denied;
  const idem = requireIdempotencyKeyHeader(request);
  if (!idem.ok) return idem.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  }

  // Generated fresh on every attempt; the command declares
  // `hashExcludeFields: ["secret"]` so a retry under the same
  // Idempotency-Key still hash-matches and replays. On a replay the
  // ORIGINAL subscription (with the ORIGINAL stored secret) is
  // returned — this fresh secret was never stored, so it must be
  // discarded, never surfaced. The secret is only available on
  // FIRST creation; a partner that lost it revokes + recreates.
  const secret = generateWebhookSecret();

  try {
    const { output, replayed } = await withTenancyContext(resolved.context.tenancy, () =>
      executeCommandDetailed(
        CreateWebhookSubscription,
        {
          url: body["url"],
          eventTypes: body["eventTypes"],
          ...(typeof body["description"] === "string" ? { description: body["description"] } : {}),
          secret,
        },
        { idempotencyKey: `partner:${resolved.context.key.apiKeyId}:${idem.key}` }
      )
    );
    return NextResponse.json(
      {
        data: {
          id: output.subscriptionId,
          url: output.url,
          eventTypes: output.eventTypes,
          status: output.status,
          // Shown exactly once, on FIRST creation only. A replay
          // must NOT return the fresh secret generated above — it
          // does not match what is stored on the subscription.
          secret: replayed ? null : secret,
        },
        ...(replayed ? { meta: { idempotentReplay: true } } : {}),
      },
      { status: replayed ? 200 : 201 }
    );
  } catch (cause) {
    const mapped = partnerCommandError(cause);
    if (mapped !== null) return mapped;
    throw cause;
  }
}
