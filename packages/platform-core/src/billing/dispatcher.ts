// Dispatcher contract.
//
// The webhook transport handler ONLY records the event and acks 200. The
// dispatcher is invoked by the worker drain (see process-stripe-webhook-event.ts)
// and is responsible for routing supported events to a domain handler.
//
// Domain handlers MUST be:
//   - Idempotent (the worker may retry on transient failure).
//   - Tenant-scoped (every write must resolve organizationId + clinicId
//     from the Stripe customer mapping before touching invoice rows).
//   - Side-effect free at the API boundary (audit log, outbox writes
//     happen via the command handler the dispatcher calls).
//
// Throwing from a handler signals the worker to mark the event FAILED and
// schedule a retry. Returning normally signals SUCCESS.

import type Stripe from "stripe";

import type { Logger } from "../logger/types.js";

import { isSupportedStripeEventType } from "./stripe-events.js";

export interface StripeEventHandlerContext {
  readonly logger: Logger;
  readonly receivedAt: Date;
}

export type StripeEventHandler = (
  event: Stripe.Event,
  context: StripeEventHandlerContext
) => Promise<void>;

export interface StripeWebhookEventDispatcher {
  /**
   * Returns true iff the event was routed to a domain handler. Unsupported
   * event types resolve to `false` without throwing so the caller can mark
   * the row IGNORED.
   */
  dispatch(event: Stripe.Event, context: StripeEventHandlerContext): Promise<boolean>;
}

export interface CreateDispatcherInput {
  readonly handlers: Readonly<Partial<Record<string, StripeEventHandler>>>;
}

export function createStripeWebhookEventDispatcher(
  input: CreateDispatcherInput
): StripeWebhookEventDispatcher {
  const { handlers } = input;
  return {
    async dispatch(event, context) {
      if (!isSupportedStripeEventType(event.type)) {
        context.logger.debug("stripe.webhook.event.unsupported", {
          stripeEventId: event.id,
          eventType: event.type,
        });
        return false;
      }
      const handler = handlers[event.type];
      if (handler === undefined) {
        context.logger.warn("stripe.webhook.event.no_handler_registered", {
          stripeEventId: event.id,
          eventType: event.type,
        });
        return false;
      }
      await handler(event, context);
      return true;
    },
  };
}
