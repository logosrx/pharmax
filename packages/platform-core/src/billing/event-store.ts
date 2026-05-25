// Persistence contract for the `stripe_webhook_event` ledger row.
//
// Platform-core defines the interface only. The Prisma-backed
// implementation lives in `@pharmax/database` (added when phase-1 lands)
// so platform-core stays free of an ORM dependency and remains testable.
//
// Semantics:
//   - `recordReceived` MUST be idempotent on `stripeEventId`. The expected
//     SQL pattern is INSERT ... ON CONFLICT (stripe_event_id) DO NOTHING,
//     returning a flag indicating whether a new row was created.
//   - `markProcessing`, `markSucceeded`, and `markFailed` are called by the
//     worker that drains pending rows. They are NOT called by the webhook
//     transport handler.

import type Stripe from "stripe";

export type StripeWebhookEventStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "IGNORED";

export interface StripeWebhookEventRecord {
  readonly id: string;
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly apiVersion: string | null;
  readonly livemode: boolean;
  readonly payload: Stripe.Event;
  readonly status: StripeWebhookEventStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly processingStartedAt: Date | null;
  readonly processedAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

export interface RecordReceivedInput {
  readonly event: Stripe.Event;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly initialStatus: Extract<StripeWebhookEventStatus, "PENDING" | "IGNORED">;
}

export interface RecordReceivedResult {
  readonly record: StripeWebhookEventRecord;
  readonly inserted: boolean;
}

export interface StripeWebhookEventStore {
  recordReceived(input: RecordReceivedInput): Promise<RecordReceivedResult>;
  findByStripeEventId(stripeEventId: string): Promise<StripeWebhookEventRecord | null>;
  markProcessing(stripeEventId: string, startedAt: Date): Promise<StripeWebhookEventRecord>;
  markSucceeded(stripeEventId: string, processedAt: Date): Promise<StripeWebhookEventRecord>;
  markFailed(input: {
    readonly stripeEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<StripeWebhookEventRecord>;
}
