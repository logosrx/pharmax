import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { noopLogger } from "../logger/types.js";

import { createStripeWebhookEventDispatcher } from "./dispatcher.js";

function buildEvent(type: string, id = "evt_dispatch_1"): Stripe.Event {
  return {
    id,
    object: "event",
    type,
    api_version: null,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "obj_1" } },
    request: { id: null, idempotency_key: null },
    pending_webhooks: 0,
  } as unknown as Stripe.Event;
}

describe("createStripeWebhookEventDispatcher", () => {
  it("returns false for an unsupported event type without invoking any handler", async () => {
    const handler = vi.fn();
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "charge.succeeded": handler },
    });

    const dispatched = await dispatcher.dispatch(buildEvent("charge.succeeded"), {
      logger: noopLogger,
      receivedAt: new Date(),
    });

    expect(dispatched).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns false when a supported event has no registered handler", async () => {
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: {},
    });

    const dispatched = await dispatcher.dispatch(buildEvent("invoice.paid"), {
      logger: noopLogger,
      receivedAt: new Date(),
    });

    expect(dispatched).toBe(false);
  });

  it("invokes the matching handler for a supported event type", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    const event = buildEvent("invoice.paid");
    const dispatched = await dispatcher.dispatch(event, {
      logger: noopLogger,
      receivedAt: new Date(),
    });

    expect(dispatched).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toBe(event);
  });

  it("propagates handler errors so the worker can mark the event FAILED", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("downstream-billing-5xx"));
    const dispatcher = createStripeWebhookEventDispatcher({
      handlers: { "invoice.paid": handler },
    });

    await expect(
      dispatcher.dispatch(buildEvent("invoice.paid"), {
        logger: noopLogger,
        receivedAt: new Date(),
      })
    ).rejects.toThrow("downstream-billing-5xx");
  });
});
