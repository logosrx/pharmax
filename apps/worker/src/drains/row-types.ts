// Internal row types returned by the atomic-claim Prisma raw queries.
//
// These match the shape Prisma would produce for the corresponding
// model (Prisma maps unknown JSON columns to `Prisma.JsonValue`). We
// re-shape into a frozen object inside the claim helpers so downstream
// code can rely on referential immutability of claimed rows.
//
// The Stripe-shaped variant is structurally compatible with
// `billing.StripeWebhookEventRecord` from `@pharmax/platform-core`
// after a `payload as unknown as Stripe.Event` cast at the dispatch
// boundary — same casting strategy already used in
// `@pharmax/database`'s Prisma store.

import type {
  EasyPostWebhookEventStatus,
  OutboxStatus,
  Prisma,
  StripeWebhookEventStatus,
} from "@pharmax/database";

export interface ClaimedStripeWebhookEventRow {
  readonly id: string;
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly apiVersion: string | null;
  readonly livemode: boolean;
  readonly payload: Prisma.JsonValue;
  readonly status: StripeWebhookEventStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly processingStartedAt: Date | null;
  readonly processedAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

export interface ClaimedEasyPostWebhookEventRow {
  readonly id: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly trackingCode: string | null;
  readonly carrierStatus: string | null;
  readonly payload: Prisma.JsonValue;
  readonly status: EasyPostWebhookEventStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly processingStartedAt: Date | null;
  readonly processedAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

export interface ClaimedOutboxEventRow {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Prisma.JsonValue;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly createdAt: Date;
}
