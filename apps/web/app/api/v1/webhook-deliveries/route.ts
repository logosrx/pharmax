// GET /api/v1/webhook-deliveries — delivery ledger view (ADR-0032).
//
// Lets a partner self-diagnose delivery health: recent deliveries
// with status/attempts/lastError, filterable by `status` (notably
// DEAD for the dead-letter view) and `subscriptionId`.
//
// The event payload snapshot is NOT included in the list — payloads
// are phi-safe by construction but can be large; partners already
// received (or will receive) them at their endpoint.
//
// Auth: partner API key (Bearer). Scope: `webhooks.manage`.

import { readInOrgScope, WebhookDeliveryStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { NextResponse } from "next/server";

import {
  partnerJsonError,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../src/server/partner/resolve-partner-context.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export async function GET(request: Request): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.WEBHOOKS_MANAGE);
  if (denied !== null) return denied;

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const cursor = url.searchParams.get("cursor");
  const rawStatus = url.searchParams.get("status");
  const subscriptionId = url.searchParams.get("subscriptionId");

  if (rawStatus !== null && !(rawStatus in WebhookDeliveryStatus)) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_STATUS",
      message: `Unknown delivery status "${rawStatus}".`,
    });
  }

  const organizationId = resolved.context.key.organizationId;
  const rows = await readInOrgScope(organizationId, (tx) =>
    tx.webhookDelivery.findMany({
      where: {
        organizationId,
        ...(rawStatus !== null ? { status: rawStatus as WebhookDeliveryStatus } : {}),
        ...(subscriptionId !== null ? { subscriptionId } : {}),
      },
      select: {
        id: true,
        subscriptionId: true,
        eventType: true,
        status: true,
        attempts: true,
        lastError: true,
        responseStatus: true,
        nextAttemptAt: true,
        deliveredAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor !== null ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    data: page,
    pagination: {
      hasMore,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    },
  });
}
