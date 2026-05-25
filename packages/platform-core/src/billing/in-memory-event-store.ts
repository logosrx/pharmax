// In-memory implementation of `StripeWebhookEventStore`.
//
// Intended for unit tests and local development against a synthetic event
// stream. NOT safe for production: there is no durability and no row-level
// locking; concurrent worker invocations are serialized via a microtask
// guard only. The Prisma-backed implementation in `@pharmax/database`
// (phase-1) is the production store.

import type Stripe from "stripe";

import type {
  RecordReceivedInput,
  RecordReceivedResult,
  StripeWebhookEventRecord,
  StripeWebhookEventStatus,
  StripeWebhookEventStore,
} from "./event-store.js";

interface MutableRecord {
  id: string;
  stripeEventId: string;
  eventType: string;
  apiVersion: string | null;
  livemode: boolean;
  payload: Stripe.Event;
  status: StripeWebhookEventStatus;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  signatureVerifiedAt: Date;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  nextAttemptAt: Date | null;
}

function freeze(record: MutableRecord): StripeWebhookEventRecord {
  return Object.freeze({ ...record });
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `mem-stripe-webhook-event-${counter.toString(16)}`;
}

export class InMemoryStripeWebhookEventStore implements StripeWebhookEventStore {
  private readonly byStripeEventId = new Map<string, MutableRecord>();

  public async recordReceived(input: RecordReceivedInput): Promise<RecordReceivedResult> {
    const existing = this.byStripeEventId.get(input.event.id);
    if (existing !== undefined) {
      return { record: freeze(existing), inserted: false };
    }
    const record: MutableRecord = {
      id: nextId(),
      stripeEventId: input.event.id,
      eventType: input.event.type,
      apiVersion: input.event.api_version ?? null,
      livemode: input.event.livemode,
      payload: input.event,
      status: input.initialStatus,
      attempts: 0,
      lastError: null,
      receivedAt: input.receivedAt,
      signatureVerifiedAt: input.signatureVerifiedAt,
      processingStartedAt: null,
      processedAt: input.initialStatus === "IGNORED" ? input.receivedAt : null,
      nextAttemptAt: null,
    };
    this.byStripeEventId.set(input.event.id, record);
    return { record: freeze(record), inserted: true };
  }

  public async findByStripeEventId(
    stripeEventId: string
  ): Promise<StripeWebhookEventRecord | null> {
    const found = this.byStripeEventId.get(stripeEventId);
    return found === undefined ? null : freeze(found);
  }

  public async markProcessing(
    stripeEventId: string,
    startedAt: Date
  ): Promise<StripeWebhookEventRecord> {
    const record = this.requireRecord(stripeEventId);
    record.status = "PROCESSING";
    record.processingStartedAt = startedAt;
    record.attempts += 1;
    return freeze(record);
  }

  public async markSucceeded(
    stripeEventId: string,
    processedAt: Date
  ): Promise<StripeWebhookEventRecord> {
    const record = this.requireRecord(stripeEventId);
    record.status = "SUCCEEDED";
    record.processedAt = processedAt;
    record.lastError = null;
    record.nextAttemptAt = null;
    return freeze(record);
  }

  public async markFailed(input: {
    readonly stripeEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<StripeWebhookEventRecord> {
    const record = this.requireRecord(input.stripeEventId);
    record.status = "FAILED";
    record.processedAt = input.failedAt;
    record.lastError = input.errorMessage;
    record.nextAttemptAt = input.nextAttemptAt;
    return freeze(record);
  }

  private requireRecord(stripeEventId: string): MutableRecord {
    const record = this.byStripeEventId.get(stripeEventId);
    if (record === undefined) {
      throw new Error(`InMemoryStripeWebhookEventStore: unknown stripeEventId ${stripeEventId}`);
    }
    return record;
  }
}
