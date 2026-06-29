// Prisma-backed implementation of `billing.StripeWebhookEventStore`.
//
// The contract is defined in `@pharmax/platform-core/billing`. This file
// is the production implementation; tests in `@pharmax/platform-core` use
// the in-memory store so the contract can be exercised without a DB.
//
// Concurrency contract (READ THIS BEFORE TOUCHING):
//   - The webhook transport handler calls `recordReceived` exactly once
//     per delivery. Race-on-insert is handled here via P2002 catch-and-
//     refetch (equivalent to INSERT ... ON CONFLICT DO NOTHING).
//   - The worker is responsible for selecting candidate rows with
//     `FOR UPDATE SKIP LOCKED` BEFORE calling `markProcessing`. This
//     store performs unconditional updates and does NOT defend against
//     two workers racing on the same row without that upstream lock.
//
// PHI: Stripe payloads contain billing identifiers only. They are stored
// verbatim in `stripe_webhook_event.payload` so the worker can replay
// processing without re-fetching from Stripe.

import type { billing } from "@pharmax/platform-core";

import { Prisma } from "../generated/client/client.js";
import type { StripeWebhookEvent } from "../generated/client/client.js";

// Type alias for the deserialized webhook payload. Equals `Stripe.Event`
// transitively through the platform-core contract; we don't import the
// Stripe SDK directly so this package stays free of a runtime dependency
// it doesn't need.
type StripeEventPayload = billing.StripeWebhookEventRecord["payload"];

// Narrow structural shape of the PrismaClient surface this store depends
// on. PrismaClient satisfies this; tests can pass any object that does.
export interface StripeWebhookEventClient {
  readonly stripeWebhookEvent: {
    create(args: { data: Prisma.StripeWebhookEventCreateInput }): Promise<StripeWebhookEvent>;
    findUnique(args: {
      where: Prisma.StripeWebhookEventWhereUniqueInput;
    }): Promise<StripeWebhookEvent | null>;
    update(args: {
      where: Prisma.StripeWebhookEventWhereUniqueInput;
      data: Prisma.StripeWebhookEventUpdateInput;
    }): Promise<StripeWebhookEvent>;
  };
}

export class PrismaStripeWebhookEventStore implements billing.StripeWebhookEventStore {
  public constructor(private readonly client: StripeWebhookEventClient) {}

  public async recordReceived(
    input: billing.RecordReceivedInput
  ): Promise<billing.RecordReceivedResult> {
    const data: Prisma.StripeWebhookEventCreateInput = {
      stripeEventId: input.event.id,
      eventType: input.event.type,
      apiVersion: input.event.api_version ?? null,
      livemode: input.event.livemode,
      payload: input.event as unknown as Prisma.InputJsonValue,
      status: input.initialStatus,
      receivedAt: input.receivedAt,
      signatureVerifiedAt: input.signatureVerifiedAt,
      processedAt: input.initialStatus === "IGNORED" ? input.receivedAt : null,
    };

    try {
      const created = await this.client.stripeWebhookEvent.create({ data });
      return { record: toRecord(created), inserted: true };
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        const existing = await this.client.stripeWebhookEvent.findUnique({
          where: { stripeEventId: input.event.id },
        });
        if (existing === null) {
          // The conflict was reported, but the row was deleted between
          // the failed insert and our refetch. Vanishingly unlikely; if
          // it happens we re-throw because the caller's invariant
          // ("at-least-one row exists for this event id after this call")
          // can no longer be honored.
          throw cause;
        }
        return { record: toRecord(existing), inserted: false };
      }
      throw cause;
    }
  }

  public async findByStripeEventId(
    stripeEventId: string
  ): Promise<billing.StripeWebhookEventRecord | null> {
    const found = await this.client.stripeWebhookEvent.findUnique({
      where: { stripeEventId },
    });
    return found === null ? null : toRecord(found);
  }

  public async markProcessing(
    stripeEventId: string,
    startedAt: Date
  ): Promise<billing.StripeWebhookEventRecord> {
    const updated = await this.client.stripeWebhookEvent.update({
      where: { stripeEventId },
      data: {
        status: "PROCESSING",
        processingStartedAt: startedAt,
        attempts: { increment: 1 },
      },
    });
    return toRecord(updated);
  }

  public async markSucceeded(
    stripeEventId: string,
    processedAt: Date
  ): Promise<billing.StripeWebhookEventRecord> {
    const updated = await this.client.stripeWebhookEvent.update({
      where: { stripeEventId },
      data: {
        status: "SUCCEEDED",
        processedAt,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    return toRecord(updated);
  }

  public async markFailed(input: {
    readonly stripeEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<billing.StripeWebhookEventRecord> {
    const updated = await this.client.stripeWebhookEvent.update({
      where: { stripeEventId: input.stripeEventId },
      data: {
        status: "FAILED",
        processedAt: input.failedAt,
        lastError: input.errorMessage,
        nextAttemptAt: input.nextAttemptAt,
      },
    });
    return toRecord(updated);
  }
}

function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002";
}

function toRecord(row: StripeWebhookEvent): billing.StripeWebhookEventRecord {
  return Object.freeze({
    id: row.id,
    stripeEventId: row.stripeEventId,
    eventType: row.eventType,
    apiVersion: row.apiVersion,
    livemode: row.livemode,
    payload: row.payload as unknown as StripeEventPayload,
    status: row.status as billing.StripeWebhookEventStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    receivedAt: row.receivedAt,
    signatureVerifiedAt: row.signatureVerifiedAt,
    processingStartedAt: row.processingStartedAt,
    processedAt: row.processedAt,
    nextAttemptAt: row.nextAttemptAt,
  });
}
