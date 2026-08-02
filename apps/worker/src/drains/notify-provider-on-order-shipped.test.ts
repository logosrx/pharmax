// Contract tests for the prescriber shipment-notification outbox
// handler (ADR-0033, slice 3). DB-free: fake Prisma order lookup +
// the InMemoryNotificationChannel.
//
// Invariants pinned:
//   1. Only providers with an ACTIVE portal account are notified;
//      un-enrolled / PENDING_SETUP / DISABLED are skipped silently.
//   2. Rx numbers are grouped per prescriber — a two-provider order
//      produces one email per enrolled provider, each carrying only
//      that provider's own rx numbers.
//   3. Missing notification channel and missing order are benign
//      skips (no throw, no retry storm).
//   4. A recipient failure throws (→ drainer backoff), with
//      per-recipient idempotency keys carrying the outbox row id.
//
// All identifiers below are synthetic.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureNotifications,
  InMemoryNotificationChannel,
  resetNotificationsConfigurationForTests,
} from "@pharmax/notifications";
import { logger } from "@pharmax/platform-core";

import { createNotifyProviderOnOrderShippedHandler } from "./notify-provider-on-order-shipped.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";
import type { OutboxHandlerContext } from "./outbox-handlers.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000a1";
const OUTBOX_ID = "00000000-0000-4000-8000-0000000000f1";
const SHIPPED_AT = "2026-07-31T15:00:00.000Z";

afterEach(() => {
  resetNotificationsConfigurationForTests();
});

function row(payload: Record<string, unknown> = {}): ClaimedOutboxEventRow {
  return {
    id: OUTBOX_ID,
    organizationId: ORG_ID,
    eventType: "order.shipped.v1",
    aggregateType: "Order",
    aggregateId: ORDER_ID,
    payload: {
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      trackingNumber: "1Z999TEST0000001",
      occurredAt: SHIPPED_AT,
      ...payload,
    },
    status: "PENDING",
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    dispatchedAt: null,
    traceparent: null,
    createdAt: new Date(SHIPPED_AT),
  };
}

const context: OutboxHandlerContext = {
  logger: logger.noopLogger,
  receivedAt: new Date(SHIPPED_AT),
};

interface FakeLine {
  readonly rxNumber: string;
  readonly account: { id: string; email: string; status: string } | null;
}

function fakeClient(lines: ReadonlyArray<FakeLine> | null) {
  return {
    order: {
      findFirst: vi.fn(async () =>
        lines === null
          ? null
          : {
              id: ORDER_ID,
              externalOrderNumber: "EXT-1001",
              shippedAt: new Date(SHIPPED_AT),
              orderLines: lines.map((line) => ({
                prescription: {
                  rxNumber: line.rxNumber,
                  providerId: "provider-x",
                  provider: { portalAccount: line.account },
                },
              })),
            }
      ),
    },
  } as never;
}

function activeAccount(id: string): FakeLine["account"] {
  return { id, email: `${id}@example-practice.test`, status: "ACTIVE" };
}

describe("notify-provider-on-order-shipped", () => {
  it("emails each enrolled prescriber once with their own rx numbers", async () => {
    const channel = new InMemoryNotificationChannel();
    configureNotifications({ channel });
    const handler = createNotifyProviderOnOrderShippedHandler({
      client: fakeClient([
        { rxNumber: "RX-1", account: activeAccount("acct-1") },
        { rxNumber: "RX-2", account: activeAccount("acct-1") },
        { rxNumber: "RX-3", account: activeAccount("acct-2") },
      ]),
    });

    await handler(row(), context);

    const sent = channel.getSent();
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.template)).toEqual([
      "PORTAL_ORDER_SHIPPED_V1",
      "PORTAL_ORDER_SHIPPED_V1",
    ]);

    const first = sent.find((s) => s.recipient.address === "acct-1@example-practice.test");
    expect(first?.context["rxNumbers"]).toBe("RX-1, RX-2");
    expect(first?.context["orderExternalNumber"]).toBe("EXT-1001");
    expect(first?.context["trackingNumber"]).toBe("1Z999TEST0000001");
    expect(first?.context["shippedAtIso"]).toBe(SHIPPED_AT);

    const second = sent.find((s) => s.recipient.address === "acct-2@example-practice.test");
    expect(second?.context["rxNumbers"]).toBe("RX-3");

    // Per-recipient idempotency keys carry the outbox row id.
    expect(sent.map((s) => s.idempotencyKey).sort()).toEqual([
      `portal-ship-notify:${OUTBOX_ID}:acct-1`,
      `portal-ship-notify:${OUTBOX_ID}:acct-2`,
    ]);
  });

  it("skips providers without an ACTIVE portal account", async () => {
    const channel = new InMemoryNotificationChannel();
    configureNotifications({ channel });
    const handler = createNotifyProviderOnOrderShippedHandler({
      client: fakeClient([
        { rxNumber: "RX-1", account: null },
        {
          rxNumber: "RX-2",
          account: { id: "acct-p", email: "p@example.test", status: "PENDING_SETUP" },
        },
        {
          rxNumber: "RX-3",
          account: { id: "acct-d", email: "d@example.test", status: "DISABLED" },
        },
      ]),
    });

    await handler(row(), context);

    expect(channel.getSent()).toHaveLength(0);
  });

  it("no-ops when notifications are not configured", async () => {
    const client = fakeClient([{ rxNumber: "RX-1", account: activeAccount("acct-1") }]);
    const handler = createNotifyProviderOnOrderShippedHandler({ client });

    await expect(handler(row(), context)).resolves.toBeUndefined();
    // The order lookup never runs — the skip happens at the channel gate.
    expect((client as { order: { findFirst: unknown } }).order.findFirst).not.toHaveBeenCalled();
  });

  it("drops a poison payload (order not found) without throwing", async () => {
    const channel = new InMemoryNotificationChannel();
    configureNotifications({ channel });
    const handler = createNotifyProviderOnOrderShippedHandler({ client: fakeClient(null) });

    await expect(handler(row(), context)).resolves.toBeUndefined();
    expect(channel.getSent()).toHaveLength(0);
  });

  it("omits trackingNumber from the context when the payload has none", async () => {
    const channel = new InMemoryNotificationChannel();
    configureNotifications({ channel });
    const handler = createNotifyProviderOnOrderShippedHandler({
      client: fakeClient([{ rxNumber: "RX-1", account: activeAccount("acct-1") }]),
    });

    await handler(row({ trackingNumber: null }), context);

    const sent = channel.getSent();
    expect(sent).toHaveLength(1);
    expect("trackingNumber" in sent[0]!.context).toBe(false);
  });

  it("throws when a recipient send fails so the drainer retries", async () => {
    const channel = new InMemoryNotificationChannel();
    channel.failNext({ code: "NOTIFICATION_TRANSPORT_ERROR", message: "boom" });
    configureNotifications({ channel });
    const handler = createNotifyProviderOnOrderShippedHandler({
      client: fakeClient([{ rxNumber: "RX-1", account: activeAccount("acct-1") }]),
    });

    await expect(handler(row(), context)).rejects.toMatchObject({
      code: "PROVIDER_SHIP_NOTIFY_ALL_RECIPIENTS_FAILED",
    });
  });
});
