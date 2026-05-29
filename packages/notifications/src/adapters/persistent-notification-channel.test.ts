import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryNotificationChannel } from "./in-memory-notification-channel.js";
import { PersistentNotificationChannel } from "./persistent-notification-channel.js";
import type { NotificationDeliveryStore } from "../ports/notification-delivery-store.js";
import type { NotificationSendInput } from "../ports/notification-channel.js";

function buildStore(): {
  store: NotificationDeliveryStore;
  calls: Array<{ op: string; args: unknown }>;
} {
  const calls: Array<{ op: string; args: unknown }> = [];
  return {
    calls,
    store: {
      recordQueued: vi.fn(async (args) => {
        calls.push({ op: "recordQueued", args });
      }),
      markSent: vi.fn(async (args) => {
        calls.push({ op: "markSent", args });
      }),
      markFailed: vi.fn(async (args) => {
        calls.push({ op: "markFailed", args });
      }),
    },
  };
}

const ORG = "11111111-1111-1111-1111-000000000001";

function baseInput(overrides: Partial<NotificationSendInput> = {}): NotificationSendInput {
  return {
    to: { kind: "email", address: "ops@acme.test" },
    template: "REPORT_RUN_COMPLETED_V1",
    context: {
      scheduleName: "X",
      reportTitle: "T",
      runStatus: "SUCCEEDED",
      windowFromIso: "2026-05-01T00:00:00.000Z",
      windowToIso: "2026-05-28T00:00:00.000Z",
      rowCount: 1,
      generatedAtIso: "2026-05-28T00:00:00.000Z",
      dashboardLink: "https://ops.test/x",
    },
    idempotencyKey: "k1",
    organizationId: ORG,
    correlationId: "run-1",
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("PersistentNotificationChannel", () => {
  it("records QUEUED then SENT around a successful send", async () => {
    const inner = new InMemoryNotificationChannel({ supportedRecipientKinds: ["email"] });
    const { store, calls } = buildStore();
    const channel = new PersistentNotificationChannel({ inner, store });

    const result = await channel.send(baseInput());

    expect(result.status).toBe("delivered");
    expect(calls.map((c) => c.op)).toEqual(["recordQueued", "markSent"]);
    const queued = calls[0]!.args as {
      organizationId: string;
      channelName: string;
      correlationId?: string;
    };
    expect(queued.organizationId).toBe(ORG);
    expect(queued.channelName).toBe(inner.metadata.name);
    expect(queued.correlationId).toBe("run-1");
    const sent = calls[1]!.args as { providerMessageId: string };
    expect(sent.providerMessageId).toBe(result.deliveryId);
  });

  it("records QUEUED then FAILED and re-throws when the inner send throws", async () => {
    const inner = new InMemoryNotificationChannel({ supportedRecipientKinds: ["email"] });
    inner.failNext({ code: "NOTIFICATION_TRANSPORT_ERROR", message: "boom" });
    const { store, calls } = buildStore();
    const channel = new PersistentNotificationChannel({ inner, store });

    await expect(channel.send(baseInput())).rejects.toMatchObject({
      code: "NOTIFICATION_TRANSPORT_ERROR",
    });
    expect(calls.map((c) => c.op)).toEqual(["recordQueued", "markFailed"]);
  });

  it("passes through without persistence when organizationId is absent", async () => {
    const inner = new InMemoryNotificationChannel({ supportedRecipientKinds: ["email"] });
    const { store, calls } = buildStore();
    const channel = new PersistentNotificationChannel({ inner, store });

    // Omit the optional key entirely (exactOptionalPropertyTypes
    // rejects an explicit `organizationId: undefined`).
    const { organizationId: _organizationId, ...inputWithoutOrg } = baseInput();
    const result = await channel.send(inputWithoutOrg);
    expect(result.status).toBe("delivered");
    expect(calls).toHaveLength(0);
  });

  it("does NOT fail the send when the store throws (onStoreError hook fires)", async () => {
    const inner = new InMemoryNotificationChannel({ supportedRecipientKinds: ["email"] });
    const errors: Array<string> = [];
    const store: NotificationDeliveryStore = {
      recordQueued: vi.fn(async () => {
        throw new Error("db down");
      }),
      markSent: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    const channel = new PersistentNotificationChannel({
      inner,
      store,
      onStoreError: (stage) => errors.push(stage),
    });

    const result = await channel.send(baseInput());
    expect(result.status).toBe("delivered");
    expect(errors).toContain("recordQueued");
  });

  it("exposes the inner channel metadata", () => {
    const inner = new InMemoryNotificationChannel({
      name: "resend-email",
      supportedRecipientKinds: ["email"],
    });
    const { store } = buildStore();
    const channel = new PersistentNotificationChannel({ inner, store });
    expect(channel.metadata.name).toBe("resend-email");
  });
});
