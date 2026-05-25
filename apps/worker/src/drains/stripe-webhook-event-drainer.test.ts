// Stripe webhook drainer tests use:
//   - A mocked `$queryRaw` that returns whatever rows the test seeds.
//   - The platform-core `InMemoryStripeWebhookEventStore` so the
//     dispatch path runs against a real store implementation (no
//     mocking of the part we're trying to exercise).
//
// The claim helper is exercised end-to-end with a fake $queryRaw — we
// don't try to test the actual SQL against Postgres here. SQL is
// validated by the integration smoke test in CI (next PR adds it).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { billing, logger as loggerNs } from "@pharmax/platform-core";

import type { StripeWebhookClaimClient } from "./claim-stripe-webhook-events.js";
import { createStripeWebhookDrainer } from "./stripe-webhook-event-drainer.js";

const noopLogger = loggerNs.noopLogger;

const fixedNow = new Date("2026-05-13T12:00:00.000Z");

interface FakeRowInput {
  readonly stripeEventId: string;
  readonly eventType?: string;
  readonly attempts?: number;
}

function fakeStripeEvent(input: FakeRowInput): Record<string, unknown> {
  return {
    id: input.stripeEventId,
    object: "event",
    type: input.eventType ?? "invoice.paid",
    api_version: null,
    livemode: false,
    created: Math.floor(fixedNow.getTime() / 1000),
    data: { object: { id: "obj_1" } },
    request: { id: null, idempotency_key: null },
    pending_webhooks: 0,
  };
}

function makeClaimClient(rows: Array<Record<string, unknown>>): {
  client: StripeWebhookClaimClient;
  queryRaw: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  const client: StripeWebhookClaimClient = {
    $queryRaw: queryRaw as unknown as StripeWebhookClaimClient["$queryRaw"],
  };
  return { client, queryRaw };
}

async function seedClaimedRow(
  store: billing.InMemoryStripeWebhookEventStore,
  input: FakeRowInput
): Promise<billing.StripeWebhookEventRecord> {
  const event = fakeStripeEvent(input) as unknown as Parameters<
    billing.InMemoryStripeWebhookEventStore["recordReceived"]
  >[0]["event"];
  await store.recordReceived({
    event,
    receivedAt: fixedNow,
    signatureVerifiedAt: fixedNow,
    initialStatus: "PENDING",
  });
  // Simulate the worker's atomic claim having flipped status to
  // PROCESSING and bumped attempts.
  return store.markProcessing(input.stripeEventId, fixedNow);
}

function rowFromRecord(record: billing.StripeWebhookEventRecord): Record<string, unknown> {
  return {
    id: record.id,
    stripeEventId: record.stripeEventId,
    eventType: record.eventType,
    apiVersion: record.apiVersion,
    livemode: record.livemode,
    payload: record.payload,
    status: record.status,
    attempts: record.attempts,
    lastError: record.lastError,
    receivedAt: record.receivedAt,
    signatureVerifiedAt: record.signatureVerifiedAt,
    processingStartedAt: record.processingStartedAt,
    processedAt: record.processedAt,
    nextAttemptAt: record.nextAttemptAt,
  };
}

describe("createStripeWebhookDrainer.tick", () => {
  let store: billing.InMemoryStripeWebhookEventStore;

  beforeEach(() => {
    store = new billing.InMemoryStripeWebhookEventStore();
  });

  it("returns zeros when no rows are claimable", async () => {
    const { client } = makeClaimClient([]);
    const dispatcher = billing.createStripeWebhookEventDispatcher({ handlers: {} });

    const drainer = createStripeWebhookDrainer(
      { client, eventStore: store, dispatcher, logger: noopLogger },
      { batchSize: 10, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
  });

  it("dispatches each claimed row through the dispatcher and marks SUCCEEDED", async () => {
    const claimed = await seedClaimedRow(store, { stripeEventId: "evt_drain_1" });
    const { client } = makeClaimClient([rowFromRecord(claimed)]);

    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = billing.createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const drainer = createStripeWebhookDrainer(
      { client, eventStore: store, dispatcher, logger: noopLogger },
      { batchSize: 10, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(handler).toHaveBeenCalledOnce();

    const after = await store.findByStripeEventId("evt_drain_1");
    expect(after?.status).toBe("SUCCEEDED");
    // The claim happens OUTSIDE the store in production (raw SQL); the
    // in-memory store reflects markProcessing exactly once. The drainer
    // must NOT call markProcessing again — attempts stays at 1.
    expect(after?.attempts).toBe(1);
  });

  it("treats unsupported event types as success and does not retry them", async () => {
    const claimed = await seedClaimedRow(store, {
      stripeEventId: "evt_drain_unsup",
      eventType: "charge.refunded",
    });
    const { client } = makeClaimClient([rowFromRecord(claimed)]);
    const dispatcher = billing.createStripeWebhookEventDispatcher({ handlers: {} });

    const drainer = createStripeWebhookDrainer(
      { client, eventStore: store, dispatcher, logger: noopLogger },
      { batchSize: 10, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const after = await store.findByStripeEventId("evt_drain_unsup");
    expect(after?.status).toBe("SUCCEEDED");
  });

  it("counts handler-thrown failures as `failed` and writes markFailed", async () => {
    const claimed = await seedClaimedRow(store, { stripeEventId: "evt_drain_fail" });
    const { client } = makeClaimClient([rowFromRecord(claimed)]);

    const dispatcher = billing.createStripeWebhookEventDispatcher({
      handlers: {
        "invoice.paid": vi.fn().mockRejectedValue(new Error("downstream-503")),
      },
    });

    const drainer = createStripeWebhookDrainer(
      { client, eventStore: store, dispatcher, logger: noopLogger },
      { batchSize: 10, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const after = await store.findByStripeEventId("evt_drain_fail");
    expect(after?.status).toBe("FAILED");
    expect(after?.lastError).toContain("downstream-503");
    expect(after?.nextAttemptAt).not.toBeNull();
  });

  it("processes a batch row-by-row, tallying mixed outcomes", async () => {
    const a = await seedClaimedRow(store, { stripeEventId: "evt_a" });
    const b = await seedClaimedRow(store, { stripeEventId: "evt_b" });
    const c = await seedClaimedRow(store, { stripeEventId: "evt_c" });
    const { client } = makeClaimClient([rowFromRecord(a), rowFromRecord(b), rowFromRecord(c)]);

    const dispatcher = billing.createStripeWebhookEventDispatcher({
      handlers: {
        "invoice.paid": vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("transient"))
          .mockResolvedValueOnce(undefined),
      },
    });

    const drainer = createStripeWebhookDrainer(
      { client, eventStore: store, dispatcher, logger: noopLogger },
      { batchSize: 10, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result.claimed).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
  });
});
