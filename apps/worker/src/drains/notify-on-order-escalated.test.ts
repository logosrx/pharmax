// Tests for the emergency-bucket escalation notification handler.
//
// The catastrophic failure mode this handler exists to prevent is
// "an order landed in the EMERGENCY bucket and the alert silently
// never fired". Every terminal path in this suite therefore asserts
// one of three loud outcomes: ≥1 notification sent, a recorded
// (logged) drop with a stable event name, or a thrown error that
// routes the outbox row back through retry/backoff. There is no
// silent no-op path.
//
// Synthetic data only — fabricated ids, `*.test` email addresses,
// no PHI in payloads or contexts.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const channelSendMock = vi.hoisted(() =>
  vi.fn(async () => ({
    deliveryId: "del-1",
    status: "delivered" as const,
    recipientKind: "email" as const,
    sentAt: new Date(),
  }))
);

const getNotificationChannelMock = vi.hoisted(() =>
  vi.fn(() => ({
    metadata: {
      name: "fake",
      supportedRecipientKinds: ["email"] as const,
      phiCapable: false,
    },
    send: channelSendMock,
  }))
);

vi.mock("@pharmax/notifications", async () => {
  type NotificationsModule = typeof NotificationsModuleType;
  const actual = (await vi.importActual("@pharmax/notifications")) as NotificationsModule;
  return {
    ...actual,
    getNotificationChannel: getNotificationChannelMock,
  };
});

import { errors } from "@pharmax/platform-core";
import type { logger as loggerNs } from "@pharmax/platform-core";
import { NOTIFICATIONS_NOT_CONFIGURED } from "@pharmax/notifications";
import type * as NotificationsModuleType from "@pharmax/notifications";

import { createNotifyOnOrderEscalatedHandler } from "./notify-on-order-escalated.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

const ORG_ID = "11111111-1111-1111-1111-000000000001";
const ORDER_ID = "22222222-2222-2222-2222-000000000001";
const ADMIN_A = { id: "33333333-3333-3333-3333-00000000000a", email: "ops-a@acme.test" };
const ADMIN_B = { id: "33333333-3333-3333-3333-00000000000b", email: "ops-b@acme.test" };

const SLA_EVENT = "order.sla_breach_escalated.v1";
const SHIPMENT_EVENT = "order.escalated_to_emergency.v1";

interface RowOverrides {
  readonly id?: string;
  readonly eventType?: string;
  readonly payload?: Record<string, unknown> | null;
}

function buildRow(overrides: RowOverrides = {}): ClaimedOutboxEventRow {
  return Object.freeze({
    id: overrides.id ?? "outbox-esc-1",
    organizationId: ORG_ID,
    eventType: overrides.eventType ?? SLA_EVENT,
    aggregateType: "Order",
    aggregateId: ORDER_ID,
    payload: (overrides.payload !== undefined
      ? overrides.payload
      : {
          orderId: ORDER_ID,
          slaDeadlineAt: "2026-08-01T10:00:00.000Z",
          breachedAt: "2026-08-01T10:05:00.000Z",
        }) as ClaimedOutboxEventRow["payload"],
    status: "PENDING",
    attempts: 1,
    lastError: null,
    nextAttemptAt: null,
    dispatchedAt: null,
    traceparent: null,
    createdAt: new Date("2026-08-01T10:05:01.000Z"),
  });
}

interface FakeClientOptions {
  readonly order?: { id: string; externalOrderNumber: string | null } | null;
  readonly admins?: Array<{ id: string; email: string }>;
}

function buildClient(options: FakeClientOptions = {}): {
  order: { findFirst: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
} {
  return {
    order: {
      findFirst: vi.fn(async () =>
        options.order !== undefined
          ? options.order
          : { id: ORDER_ID, externalOrderNumber: "RX-1001" }
      ),
    },
    user: {
      findMany: vi.fn(async () => options.admins ?? [ADMIN_A, ADMIN_B]),
    },
  };
}

interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly context: Record<string, unknown> | undefined;
}

function buildRecordingLogger(): { logger: loggerNs.Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: loggerNs.Logger = {
    debug: (message, context) => void entries.push({ level: "debug", message, context }),
    info: (message, context) => void entries.push({ level: "info", message, context }),
    warn: (message, context) => void entries.push({ level: "warn", message, context }),
    error: (message, context) => void entries.push({ level: "error", message, context }),
    child: () => logger,
  };
  return { logger, entries };
}

function buildCtx(): {
  ctx: { logger: loggerNs.Logger; receivedAt: Date };
  entries: LogEntry[];
} {
  const { logger, entries } = buildRecordingLogger();
  return { ctx: { logger, receivedAt: new Date("2026-08-01T10:05:02.000Z") }, entries };
}

type SendCall = {
  to: { kind: string; address: string };
  template: string;
  context: Record<string, unknown>;
  idempotencyKey: string;
  organizationId: string;
  correlationId: string;
};

function sendCalls(): SendCall[] {
  return channelSendMock.mock.calls.map((call) => (call as ReadonlyArray<unknown>)[0] as SendCall);
}

beforeEach(() => {
  channelSendMock.mockReset();
  channelSendMock.mockResolvedValue({
    deliveryId: "del-1",
    status: "delivered" as const,
    recipientKind: "email" as const,
    sentAt: new Date(),
  });
  getNotificationChannelMock.mockReset();
  getNotificationChannelMock.mockReturnValue({
    metadata: { name: "fake", supportedRecipientKinds: ["email"], phiCapable: false },
    send: channelSendMock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notify-on-order-escalated — SLA breach trigger", () => {
  it("sends one notification per OrgAdmin with the SLA template and per-recipient idempotency keys", async () => {
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await handler(buildRow(), ctx);

    expect(channelSendMock).toHaveBeenCalledTimes(2);
    const calls = sendCalls();
    expect(calls.map((call) => call.to)).toEqual([
      { kind: "email", address: ADMIN_A.email },
      { kind: "email", address: ADMIN_B.email },
    ]);
    for (const call of calls) {
      expect(call.template).toBe("ORDER_SLA_BREACH_ESCALATED_V1");
      expect(call.context).toEqual({
        orderExternalNumber: "RX-1001",
        slaDeadlineAtIso: "2026-08-01T10:00:00.000Z",
        breachedAtIso: "2026-08-01T10:05:00.000Z",
      });
      expect(call.organizationId).toBe(ORG_ID);
      expect(call.correlationId).toBe("outbox-esc-1");
    }
    // Per-recipient keys: a retried outbox row re-sends with the
    // SAME keys so the channel dedupes; distinct recipients never
    // collide with each other.
    expect(calls.map((call) => call.idempotencyKey)).toEqual([
      `escalation-notify:outbox-esc-1:${ADMIN_A.id}`,
      `escalation-notify:outbox-esc-1:${ADMIN_B.id}`,
    ]);
  });

  it("scopes BOTH lookups to the outbox row's organization (cross-tenant drain, explicit org scoping)", async () => {
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await handler(buildRow(), ctx);

    expect(client.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID, organizationId: ORG_ID },
      })
    );
    const findManyArgs = client.user.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(findManyArgs.where["organizationId"]).toBe(ORG_ID);
    expect(findManyArgs.where["status"]).toBe("ACTIVE");
  });
});

describe("notify-on-order-escalated — shipment exception trigger", () => {
  it("sends the shipment-escalation template with reason + carrier status from the payload", async () => {
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await handler(
      buildRow({
        eventType: SHIPMENT_EVENT,
        payload: { orderId: ORDER_ID, reason: "DELIVERY_EXCEPTION", carrierStatus: "RETURNED" },
      }),
      ctx
    );

    expect(channelSendMock).toHaveBeenCalledTimes(2);
    const first = sendCalls()[0];
    expect(first?.template).toBe("SHIPMENT_ESCALATED_V1");
    expect(first?.context).toEqual({
      orderExternalNumber: "RX-1001",
      escalationReason: "DELIVERY_EXCEPTION",
      lastTrackingStatus: "RETURNED",
    });
  });

  it("defaults reason/carrier status to UNKNOWN when the payload omits them", async () => {
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await handler(buildRow({ eventType: SHIPMENT_EVENT, payload: { orderId: ORDER_ID } }), ctx);

    const first = sendCalls()[0];
    expect(first?.context).toEqual({
      orderExternalNumber: "RX-1001",
      escalationReason: "UNKNOWN",
      lastTrackingStatus: "UNKNOWN",
    });
  });

  it("falls back to the internal order id when no external order number exists", async () => {
    const client = buildClient({ order: { id: ORDER_ID, externalOrderNumber: null } });
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await handler(buildRow({ eventType: SHIPMENT_EVENT, payload: { orderId: ORDER_ID } }), ctx);

    expect(sendCalls()[0]?.context["orderExternalNumber"]).toBe(ORDER_ID);
  });

  it("resolves the order from aggregateId when the payload has no orderId (null payload)", async () => {
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await handler(buildRow({ eventType: SHIPMENT_EVENT, payload: null }), ctx);

    expect(client.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ORDER_ID, organizationId: ORG_ID } })
    );
    expect(channelSendMock).toHaveBeenCalled();
  });
});

describe("notify-on-order-escalated — no silent no-op paths", () => {
  it("zero recipients: does not throw, but records a LOUD warn with the role it searched for", async () => {
    // Current contract: an org with no ACTIVE OrgAdmin gets a
    // `no_recipients` WARN and the row is dropped (retrying cannot
    // conjure recipients). This test pins that the drop is recorded
    // — if this ever becomes a silent return, the emergency queue's
    // worst failure mode is back.
    const client = buildClient({ admins: [] });
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx, entries } = buildCtx();

    await handler(buildRow(), ctx);

    expect(channelSendMock).not.toHaveBeenCalled();
    const warn = entries.find(
      (entry) => entry.message === "outbox.notify_escalation.no_recipients"
    );
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    expect(warn?.context).toMatchObject({
      outboxId: "outbox-esc-1",
      eventType: SLA_EVENT,
      roleCode: "OrgAdmin",
    });
  });

  it("order not found (poison payload): drops with a LOUD error log, no notification", async () => {
    const client = buildClient({ order: null });
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx, entries } = buildCtx();

    await handler(buildRow(), ctx);

    expect(channelSendMock).not.toHaveBeenCalled();
    const error = entries.find(
      (entry) => entry.message === "outbox.notify_escalation.order_not_found"
    );
    expect(error).toBeDefined();
    expect(error?.level).toBe("error");
  });

  it("notifications-not-configured (dev): benign skip is INFO-logged, nothing thrown", async () => {
    getNotificationChannelMock.mockImplementation(() => {
      throw new errors.InternalError({ code: NOTIFICATIONS_NOT_CONFIGURED, message: "no channel" });
    });
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx, entries } = buildCtx();

    await handler(buildRow(), ctx);

    expect(channelSendMock).not.toHaveBeenCalled();
    // The skip gate runs before any DB work.
    expect(client.order.findFirst).not.toHaveBeenCalled();
    expect(
      entries.some((entry) => entry.message === "outbox.notify_escalation.skipped_no_channel")
    ).toBe(true);
  });

  it("any OTHER channel-resolution failure is rethrown (→ outbox retry), never swallowed", async () => {
    getNotificationChannelMock.mockImplementation(() => {
      throw new errors.InternalError({
        code: "NOTIFICATION_CHANNEL_BOOT_RACE",
        message: "channel not ready",
      });
    });
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await expect(handler(buildRow(), ctx)).rejects.toMatchObject({
      code: "NOTIFICATION_CHANNEL_BOOT_RACE",
    });
  });
});

describe("notify-on-order-escalated — recipient failure isolation", () => {
  it("throws ALL_RECIPIENTS_FAILED when every send fails — the row must retry, not dispatch", async () => {
    channelSendMock.mockImplementation(async () => {
      throw new errors.InternalError({ code: "NOTIFICATION_TRANSPORT_ERROR", message: "outage" });
    });
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await expect(handler(buildRow(), ctx)).rejects.toMatchObject({
      code: "ESCALATION_NOTIFY_ALL_RECIPIENTS_FAILED",
      metadata: expect.objectContaining({ succeeded: 0, failed: 2 }),
    });
    // Both recipients were still ATTEMPTED — one bounce never
    // aborts the rest of the fan-out.
    expect(channelSendMock).toHaveBeenCalledTimes(2);
  });

  it("throws SOME_RECIPIENTS_FAILED on partial failure — successes dedupe on the retry", async () => {
    let call = 0;
    channelSendMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        throw new errors.InternalError({ code: "NOTIFICATION_TRANSPORT_ERROR", message: "5xx" });
      }
      return {
        deliveryId: "del-2",
        status: "delivered" as const,
        recipientKind: "email" as const,
        sentAt: new Date(),
      };
    });
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx, entries } = buildCtx();

    await expect(handler(buildRow(), ctx)).rejects.toMatchObject({
      code: "ESCALATION_NOTIFY_SOME_RECIPIENTS_FAILED",
      metadata: expect.objectContaining({
        succeeded: 1,
        failed: 1,
        firstFailureCode: "NOTIFICATION_TRANSPORT_ERROR",
      }),
    });
    expect(channelSendMock).toHaveBeenCalledTimes(2);
    // The per-recipient failure log carries the user id, never the
    // email address (account identifiers stay out of logs).
    const recipientWarn = entries.find(
      (entry) => entry.message === "outbox.notify_escalation.recipient_failed"
    );
    expect(recipientWarn?.context).toMatchObject({ recipientUserId: ADMIN_A.id });
    expect(JSON.stringify(recipientWarn?.context)).not.toContain(ADMIN_A.email);
  });

  it("classifies a non-PharmaxError transport throw under the generic transport code", async () => {
    channelSendMock.mockImplementation(async () => {
      throw new Error("socket hang up");
    });
    const client = buildClient({ admins: [ADMIN_A] });
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx } = buildCtx();

    await expect(handler(buildRow(), ctx)).rejects.toMatchObject({
      code: "ESCALATION_NOTIFY_ALL_RECIPIENTS_FAILED",
      metadata: expect.objectContaining({ firstFailureCode: "NOTIFICATION_TRANSPORT_ERROR" }),
    });
  });

  it("logs a dispatch summary when every recipient succeeded", async () => {
    const client = buildClient();
    const handler = createNotifyOnOrderEscalatedHandler({ client: client as never });
    const { ctx, entries } = buildCtx();

    await handler(buildRow(), ctx);

    const dispatched = entries.find(
      (entry) => entry.message === "outbox.notify_escalation.dispatched"
    );
    expect(dispatched?.context).toMatchObject({ recipients: 2, succeeded: 2, failed: 0 });
  });
});
