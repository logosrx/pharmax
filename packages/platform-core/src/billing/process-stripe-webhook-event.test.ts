import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { noopLogger } from "../logger/types.js";

import { createStripeWebhookEventDispatcher } from "./dispatcher.js";
import { StripeWebhookEventNotFoundError } from "./errors.js";
import { InMemoryStripeWebhookEventStore } from "./in-memory-event-store.js";
import { processStripeWebhookEvent } from "./process-stripe-webhook-event.js";

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

async function seedPending(
  store: InMemoryStripeWebhookEventStore,
  event: Stripe.Event,
  receivedAt: Date
): Promise<void> {
  await store.recordReceived({
    event,
    receivedAt,
    signatureVerifiedAt: receivedAt,
    initialStatus: "PENDING",
  });
}

describe("processStripeWebhookEvent", () => {
  let store: InMemoryStripeWebhookEventStore;
  const fixedNow = new Date("2026-05-13T12:00:00.000Z");
  const clock = (): Date => fixedNow;

  beforeEach(() => {
    store = new InMemoryStripeWebhookEventStore();
  });

  it("marks the event SUCCEEDED when the handler resolves", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_proc_1", fixedNow);
    await seedPending(store, event, receivedAt);

    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const result = await processStripeWebhookEvent(event.id, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
    });

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.record.status).toBe("SUCCEEDED");
      expect(result.record.attempts).toBe(1);
      expect(result.record.processedAt).toEqual(fixedNow);
    }
    expect(handler).toHaveBeenCalledOnce();
  });

  it("treats unsupported events as a successful no-op (no retries)", async () => {
    const { event, receivedAt } = buildEvent("charge.succeeded", "evt_proc_unsup", fixedNow);
    await seedPending(store, event, receivedAt);

    const dispatcher = createStripeWebhookEventDispatcher({ handlers: {} });

    const result = await processStripeWebhookEvent(event.id, {
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

  it("marks FAILED with a backoff when the handler throws", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_proc_fail", fixedNow);
    await seedPending(store, event, receivedAt);

    const handler = vi.fn().mockRejectedValue(new Error("downstream"));
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const result = await processStripeWebhookEvent(event.id, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.record.status).toBe("FAILED");
      expect(result.record.lastError).toContain("downstream");
      // First attempt → backoff scheduled.
      expect(result.record.nextAttemptAt).not.toBeNull();
      expect(result.retryScheduledFor).not.toBeNull();
    }
  });

  it("does NOT re-run when the event is already SUCCEEDED", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_proc_dup", fixedNow);
    await seedPending(store, event, receivedAt);

    await store.markProcessing(event.id, fixedNow);
    await store.markSucceeded(event.id, fixedNow);

    const handler = vi.fn();
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const result = await processStripeWebhookEvent(event.id, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
    });

    expect(result.status).toBe("succeeded");
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws StripeWebhookEventNotFoundError when the row is missing", async () => {
    const dispatcher = createStripeWebhookEventDispatcher({ handlers: {} });

    await expect(
      processStripeWebhookEvent("evt_does_not_exist", {
        eventStore: store,
        dispatcher,
        logger: noopLogger,
        clock,
      })
    ).rejects.toBeInstanceOf(StripeWebhookEventNotFoundError);
  });

  it("stops scheduling retries after maxAttempts is reached", async () => {
    const { event, receivedAt } = buildEvent("invoice.paid", "evt_proc_max", fixedNow);
    await seedPending(store, event, receivedAt);
    // Simulate prior attempts.
    await store.markProcessing(event.id, fixedNow);
    await store.markFailed({
      stripeEventId: event.id,
      failedAt: fixedNow,
      errorMessage: "first failure",
      nextAttemptAt: fixedNow,
    });
    await store.markProcessing(event.id, fixedNow);
    await store.markFailed({
      stripeEventId: event.id,
      failedAt: fixedNow,
      errorMessage: "second failure",
      nextAttemptAt: fixedNow,
    });

    const handler = vi.fn().mockRejectedValue(new Error("still failing"));
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const result = await processStripeWebhookEvent(event.id, {
      eventStore: store,
      dispatcher,
      logger: noopLogger,
      clock,
      maxAttempts: 3,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.retryScheduledFor).toBeNull();
      expect(result.record.nextAttemptAt).toBeNull();
    }
  });
});
