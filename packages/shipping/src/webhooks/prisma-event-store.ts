// Prisma-backed implementation of `EasyPostWebhookEventStore`.
//
// Production store wired by `apps/web` (transport edge) and
// `apps/worker` (drain). Tests in this package use
// `InMemoryEasyPostWebhookEventStore` so the contract can be
// exercised without a DB.
//
// Concurrency contract (READ THIS BEFORE TOUCHING):
//   - The webhook transport handler calls `recordReceived` exactly once
//     per delivery. Race-on-insert is handled here via P2002 catch-and-
//     refetch (equivalent to INSERT … ON CONFLICT DO NOTHING).
//   - The worker is responsible for selecting candidate rows with
//     `FOR UPDATE SKIP LOCKED` BEFORE calling `markProcessing`. This
//     store performs unconditional updates and does NOT defend against
//     two workers racing on the same row without that upstream lock.
//
// PHI: EasyPost tracker payloads CAN contain recipient name and
// address. We do NOT store them. The ingestion choke point
// (`handleEasyPostWebhook`) projects the parsed body down to the
// PHI-free replay subset via `projectTrackerEventForStorage` BEFORE
// calling `recordReceived`, so `easypost_webhook_event.payload` only
// ever holds `{id, description, result.{id, tracking_code, status,
// status_detail, updated_at, carrier}}`. Downstream audit + outbox
// stay PHI-free (shipment id + carrier status + occurredAt only) via
// `RecordShipmentTrackingEvent`.

import { Prisma, type EasyPostWebhookEvent } from "@pharmax/database";

import type { EasyPostTrackerWebhookPayload } from "../carriers/easypost-payload.js";

import type {
  EasyPostWebhookEventRecord,
  EasyPostWebhookEventStatus,
  EasyPostWebhookEventStore,
  RecordReceivedInput,
  RecordReceivedResult,
} from "./event-store.js";

// Narrow structural shape of the PrismaClient surface this store
// depends on. PrismaClient satisfies this; tests can pass any object
// that does.
export interface EasyPostWebhookEventClient {
  readonly easyPostWebhookEvent: {
    create(args: { data: Prisma.EasyPostWebhookEventCreateInput }): Promise<EasyPostWebhookEvent>;
    findUnique(args: {
      where: Prisma.EasyPostWebhookEventWhereUniqueInput;
    }): Promise<EasyPostWebhookEvent | null>;
    update(args: {
      where: Prisma.EasyPostWebhookEventWhereUniqueInput;
      data: Prisma.EasyPostWebhookEventUpdateInput;
    }): Promise<EasyPostWebhookEvent>;
  };
}

export class PrismaEasyPostWebhookEventStore implements EasyPostWebhookEventStore {
  public constructor(private readonly client: EasyPostWebhookEventClient) {}

  public async recordReceived(input: RecordReceivedInput): Promise<RecordReceivedResult> {
    const trackingCode =
      typeof input.event.result.tracking_code === "string"
        ? input.event.result.tracking_code
        : null;
    const carrierStatus =
      typeof input.event.result.status === "string" ? input.event.result.status : null;

    const data: Prisma.EasyPostWebhookEventCreateInput = {
      externalEventId: input.event.id,
      eventType: input.event.description,
      trackingCode,
      carrierStatus,
      payload: input.event as unknown as Prisma.InputJsonValue,
      status: input.initialStatus,
      receivedAt: input.receivedAt,
      signatureVerifiedAt: input.signatureVerifiedAt,
      processedAt: input.initialStatus === "IGNORED" ? input.receivedAt : null,
    };

    try {
      const created = await this.client.easyPostWebhookEvent.create({ data });
      return { record: toRecord(created), inserted: true };
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        const existing = await this.client.easyPostWebhookEvent.findUnique({
          where: { externalEventId: input.event.id },
        });
        if (existing === null) {
          throw cause;
        }
        return { record: toRecord(existing), inserted: false };
      }
      throw cause;
    }
  }

  public async findByExternalEventId(
    externalEventId: string
  ): Promise<EasyPostWebhookEventRecord | null> {
    const found = await this.client.easyPostWebhookEvent.findUnique({
      where: { externalEventId },
    });
    return found === null ? null : toRecord(found);
  }

  public async markProcessing(
    externalEventId: string,
    startedAt: Date
  ): Promise<EasyPostWebhookEventRecord> {
    const updated = await this.client.easyPostWebhookEvent.update({
      where: { externalEventId },
      data: {
        status: "PROCESSING",
        processingStartedAt: startedAt,
        attempts: { increment: 1 },
      },
    });
    return toRecord(updated);
  }

  public async markSucceeded(
    externalEventId: string,
    processedAt: Date
  ): Promise<EasyPostWebhookEventRecord> {
    const updated = await this.client.easyPostWebhookEvent.update({
      where: { externalEventId },
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
    readonly externalEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<EasyPostWebhookEventRecord> {
    const updated = await this.client.easyPostWebhookEvent.update({
      where: { externalEventId: input.externalEventId },
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

function toRecord(row: EasyPostWebhookEvent): EasyPostWebhookEventRecord {
  return Object.freeze({
    id: row.id,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    trackingCode: row.trackingCode,
    carrierStatus: row.carrierStatus,
    payload: row.payload as unknown as EasyPostTrackerWebhookPayload,
    status: row.status as EasyPostWebhookEventStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    receivedAt: row.receivedAt,
    signatureVerifiedAt: row.signatureVerifiedAt,
    processingStartedAt: row.processingStartedAt,
    processedAt: row.processedAt,
    nextAttemptAt: row.nextAttemptAt,
  });
}
