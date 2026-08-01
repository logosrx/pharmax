// Webhook subscription + delivery projections — drive
// `/ops/admin/webhooks` (ADR-0032 developer portal).
//
// Two readers:
//
//   - `listWebhookSubscriptions` — every subscription in the
//     operator's org with per-status delivery counts. Subscriptions
//     per org are bounded (a handful of partner endpoints), so this
//     is a full list.
//
//   - `listRecentWebhookDeliveries` — the newest slice of the
//     delivery ledger, for the health view. Server-side capped.
//
// The signing secret is envelope-encrypted at rest and is NEVER
// selected here — the portal shows THAT a secret exists (rotate /
// revoke are the only verbs), never the material.
//
// PHI: none. Endpoint URLs, event-type names, statuses, timestamps.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import {
  readInOrgScope,
  type WebhookDeliveryStatus,
  type WebhookSubscriptionStatus,
} from "@pharmax/database";

export interface WebhookSubscriptionListRow {
  readonly subscriptionId: string;
  readonly url: string;
  readonly eventTypes: ReadonlyArray<string>;
  readonly description: string | null;
  readonly status: WebhookSubscriptionStatus;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly createdByDisplayName: string;
  readonly deliveryCounts: Readonly<Record<WebhookDeliveryStatus, number>>;
}

export async function listWebhookSubscriptions(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<WebhookSubscriptionListRow>> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.webhookSubscription.findMany({
        where: { organizationId: input.organizationId },
        select: {
          id: true,
          url: true,
          eventTypes: true,
          description: true,
          status: true,
          disabledAt: true,
          createdAt: true,
          createdByUser: { select: { displayName: true } },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      }),
      tx.webhookDelivery.groupBy({
        by: ["subscriptionId", "status"],
        where: { organizationId: input.organizationId },
        _count: { _all: true },
      }),
    ]);

    const countsBySubscription = new Map<string, Record<WebhookDeliveryStatus, number>>();
    for (const c of counts) {
      const bucket = countsBySubscription.get(c.subscriptionId) ?? {
        PENDING: 0,
        SENT: 0,
        FAILED: 0,
        DEAD: 0,
      };
      bucket[c.status] = c._count._all;
      countsBySubscription.set(c.subscriptionId, bucket);
    }

    return rows.map((r) =>
      Object.freeze({
        subscriptionId: r.id,
        url: r.url,
        eventTypes: [...r.eventTypes].sort(),
        description: r.description,
        status: r.status,
        disabledAt: r.disabledAt,
        createdAt: r.createdAt,
        createdByDisplayName: r.createdByUser.displayName,
        deliveryCounts: Object.freeze(
          countsBySubscription.get(r.id) ?? { PENDING: 0, SENT: 0, FAILED: 0, DEAD: 0 }
        ),
      })
    );
  });
}

export interface WebhookDeliveryListRow {
  readonly deliveryId: string;
  readonly subscriptionUrl: string;
  readonly eventType: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly responseStatus: number | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
}

export async function listRecentWebhookDeliveries(input: {
  readonly organizationId: string;
  readonly limit?: number;
}): Promise<ReadonlyArray<WebhookDeliveryListRow>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return readInOrgScope(input.organizationId, async (tx) => {
    const rows = await tx.webhookDelivery.findMany({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        eventType: true,
        status: true,
        attempts: true,
        responseStatus: true,
        lastError: true,
        nextAttemptAt: true,
        deliveredAt: true,
        createdAt: true,
        subscription: { select: { url: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    return rows.map((r) =>
      Object.freeze({
        deliveryId: r.id,
        subscriptionUrl: r.subscription.url,
        eventType: r.eventType,
        status: r.status,
        attempts: r.attempts,
        responseStatus: r.responseStatus,
        lastError: r.lastError,
        nextAttemptAt: r.nextAttemptAt,
        deliveredAt: r.deliveredAt,
        createdAt: r.createdAt,
      })
    );
  });
}
