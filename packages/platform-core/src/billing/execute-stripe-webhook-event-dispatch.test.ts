// Tests for the worker-friendly inner half of the Stripe drain pipeline.
//
// The production worker claims rows atomically (single UPDATE … FROM
// SELECT … FOR UPDATE SKIP LOCKED) and then calls
// `executeStripeWebhookEventDispatch` directly. These tests exercise
// that path:
//   - It must NOT call `markProcessing` (caller already did).
//   - It must NOT re-increment `attempts`.
//   - It must run the dispatcher and finalize the row identically to
//     `processStripeWebhookEvent`.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { noopLogger } from "../logger/types.js";

import { createStripeWebhookEventDispatcher } from "./dispatcher.js";
import { InMemoryStripeWebhookEventStore } from "./in-memory-event-store.js";
import { executeStripeWebhookEventDispatch } from "./process-stripe-webhook-event.js";
import type { StripeWebhookEventRecord } from "./event-store.js";

function buildEvent(
  type: string,
  id: string,
  receivedAt: Date
): { event: Stripe.Event; receivedAt: Date } {
  return {
    event: {
      id,
      object: "event",
      type,
      api_version: null,
      livemode: false,
      created: Math.floor(receivedAt.getTime() / 1000),
      data: { object: { id: "obj_1" } },
      request: { id: null, idempotency_key: null },
      pending_webhooks: 0,
    } as unknown as Stripe.Event,
    receivedAt,
  };
}

async function seedClaimed(
  store: InMemoryStripeWebhookEventStore,
  event: Stripe.Event,
  receivedAt: Date
): Promise<StripeWebhookEventRecord> {
  await store.recordReceived({
    event,
    receivedAt,
    signatureVerifiedAt: receivedAt,
    initialStatus: "PENDING",
  });
  // Simulate the worker's atomic claim: row is now PROCESSING and
  // attempts is incremented exactly once.
  return store.markProcessing(event.id, receivedAt);
}

describe("executeStripeWebhookEventDispatch", () => {
  let store: InMemoryStripeWebhookEventStore;
  const fixedNow = new Date("2026-05-13T12:00:00.000Z");
  const clock = (): Date => fixedNow;

  beforeEach(() => {
    store = new InMemoryStripeWebhookEventStore();
  });

  it("dispatches the supplied claimed record and marks SUCCEEDED", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_exec_1", fixedNow);
    const claimed = await seedClaimed(store, event, receivedAt);

    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const markProcessingSpy = vi.spyOn(store, "markProcessing");

    const result = await executeStripeWebhookEventDispatch(claimed, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
    });

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.record.status).toBe("SUCCEEDED");
      // CRITICAL: caller already incremented attempts exactly once.
      // This function MUST NOT call markProcessing again.
      expect(result.record.attempts).toBe(1);
      expect(result.record.processedAt).toEqual(fixedNow);
    }
    expect(handler).toHaveBeenCalledOnce();
    expect(markProcessingSpy).not.toHaveBeenCalled();
  });

  it("treats unsupported event types as a successful no-op", async () => {
    const { event, receivedAt } = buildEvent("charge.refunded", "evt_exec_unsup", fixedNow);
    const claimed = await seedClaimed(store, event, receivedAt);

    const dispatcher = createStripeWebhookEventDispatcher({ handlers: {} });

    const result = await executeStripeWebhookEventDispatch(claimed, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
    });

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.record.status).toBe("SUCCEEDED");
    }
  });

  it("marks FAILED with backoff when the handler throws", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_exec_fail", fixedNow);
    const claimed = await seedClaimed(store, event, receivedAt);

    const handler = vi.fn().mockRejectedValue(new Error("downstream-500"));
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const result = await executeStripeWebhookEventDispatch(claimed, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.record.status).toBe("FAILED");
      expect(result.record.lastError).toContain("downstream-500");
      // Backoff scheduled because attempts (1) < default maxAttempts (8).
      expect(result.retryScheduledFor).not.toBeNull();
    }
  });

  it("stops scheduling retries when attempts has reached maxAttempts", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_exec_max", fixedNow);
    await store.recordReceived({
      event,
      receivedAt,
      signatureVerifiedAt: receivedAt,
      initialStatus: "PENDING",
    });
    // Simulate three prior failed cycles so attempts counter advances.
    for (let i = 0; i < 3; i += 1) {
      await store.markProcessing(event.id, receivedAt);
      await store.markFailed({
        stripeEventId: event.id,
        failedAt: receivedAt,
        errorMessage: `attempt ${i}`,
        nextAttemptAt: receivedAt,
      });
    }
    // The worker would now atomically claim again — simulate that.
    const claimed = await store.markProcessing(event.id, receivedAt);
    expect(claimed.attempts).toBe(4);

    const handler = vi.fn().mockRejectedValue(new Error("still down"));
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const result = await executeStripeWebhookEventDispatch(claimed, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
      maxAttempts: 4,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.retryScheduledFor).toBeNull();
      expect(result.record.nextAttemptAt).toBeNull();
    }
  });
});
