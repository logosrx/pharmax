import { logger as loggerNs } from "@pharmax/platform-core";
import { describe, expect, it } from "vitest";

import { fanOutWebhookDeliveries, type FanOutClient } from "./fan-out.js";

const noopLogger = loggerNs.noopLogger;

const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Registry-valid payload for platform.api_key.created.v1. */
const VALID_PAYLOAD = {
  organizationId: ORG_ID,
  apiKeyId: "11111111-1111-4111-8111-111111111111",
  name: "Acme prod",
  tokenPrefix: "pxk_abcd",
  scopes: ["orders.read"],
  createdByUserId: "33333333-3333-4333-8333-333333333333",
  occurredAt: "2026-07-24T12:00:00.000Z",
};

interface CreateManyCall {
  data: Array<Record<string, unknown>>;
  skipDuplicates: boolean;
}

function createFakeClient(input: { subscriptionIds: string[]; duplicates?: number }): {
  client: FanOutClient;
  createManyCalls: CreateManyCall[];
  findManyWheres: Array<Record<string, unknown>>;
} {
  const createManyCalls: CreateManyCall[] = [];
  const findManyWheres: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 0,
    webhookSubscription: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        findManyWheres.push(where);
        return input.subscriptionIds.map((id) => ({ id }));
      },
    },
    webhookDelivery: {
      createMany: async (args: CreateManyCall) => {
        createManyCalls.push(args);
        return { count: args.data.length - (input.duplicates ?? 0) };
      },
    },
  };
  const client = {
    $transaction: (async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) as never,
  } as unknown as FanOutClient;
  return { client, createManyCalls, findManyWheres };
}

describe("fanOutWebhookDeliveries", () => {
  it("skips non-eligible event types without touching the DB", async () => {
    const { client, createManyCalls, findManyWheres } = createFakeClient({
      subscriptionIds: ["s-1"],
    });
    const result = await fanOutWebhookDeliveries({
      client,
      // (Allowlisted parity-guard fixture name — intentionally unregistered.)
      event: {
        id: "e-1",
        organizationId: ORG_ID,
        eventType: "some.unregistered.event.v1",
        payload: {},
      },
      logger: noopLogger,
    });
    expect(result).toEqual({ created: 0, skippedReason: "not_eligible" });
    expect(findManyWheres).toHaveLength(0);
    expect(createManyCalls).toHaveLength(0);
  });

  it("skips (never egresses) a payload that fails registry validation", async () => {
    const { client, createManyCalls } = createFakeClient({ subscriptionIds: ["s-1"] });
    const result = await fanOutWebhookDeliveries({
      client,
      event: {
        id: "e-2",
        organizationId: ORG_ID,
        eventType: "platform.api_key.created.v1",
        payload: { totally: "wrong shape" },
      },
      logger: noopLogger,
    });
    expect(result).toEqual({ created: 0, skippedReason: "invalid_payload" });
    expect(createManyCalls).toHaveLength(0);
  });

  it("creates one delivery per matching ACTIVE subscription, org-scoped, idempotently", async () => {
    const { client, createManyCalls, findManyWheres } = createFakeClient({
      subscriptionIds: ["s-1", "s-2"],
    });
    const result = await fanOutWebhookDeliveries({
      client,
      event: {
        id: "e-3",
        organizationId: ORG_ID,
        eventType: "platform.api_key.created.v1",
        payload: VALID_PAYLOAD,
      },
      logger: noopLogger,
    });

    expect(result).toEqual({ created: 2, skippedReason: null });

    // The subscription query is explicitly org- and status-scoped
    // (the worker runs in system context — the WHERE is the fence).
    expect(findManyWheres[0]).toEqual({
      organizationId: ORG_ID,
      status: "ACTIVE",
      eventTypes: { has: "platform.api_key.created.v1" },
    });

    expect(createManyCalls).toHaveLength(1);
    const call = createManyCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.skipDuplicates).toBe(true);
    expect(call.data.map((d) => d["subscriptionId"])).toEqual(["s-1", "s-2"]);
    for (const row of call.data) {
      expect(row["organizationId"]).toBe(ORG_ID);
      expect(row["outboxEventId"]).toBe("e-3");
      expect(row["eventType"]).toBe("platform.api_key.created.v1");
      expect(row["payload"]).toEqual(VALID_PAYLOAD);
      // No active OTel SDK in unit tests → no trace context captured.
      expect(row["traceparent"]).toBeNull();
    }
  });

  it("reports no_subscriptions when nothing matches", async () => {
    const { client, createManyCalls } = createFakeClient({ subscriptionIds: [] });
    const result = await fanOutWebhookDeliveries({
      client,
      event: {
        id: "e-4",
        organizationId: ORG_ID,
        eventType: "platform.api_key.created.v1",
        payload: VALID_PAYLOAD,
      },
      logger: noopLogger,
    });
    expect(result).toEqual({ created: 0, skippedReason: "no_subscriptions" });
    expect(createManyCalls).toHaveLength(0);
  });

  it("counts only NEW rows when duplicates are skipped (outbox retry)", async () => {
    const { client } = createFakeClient({ subscriptionIds: ["s-1", "s-2"], duplicates: 2 });
    const result = await fanOutWebhookDeliveries({
      client,
      event: {
        id: "e-5",
        organizationId: ORG_ID,
        eventType: "platform.api_key.created.v1",
        payload: VALID_PAYLOAD,
      },
      logger: noopLogger,
    });
    expect(result).toEqual({ created: 0, skippedReason: "no_subscriptions" });
  });
});
