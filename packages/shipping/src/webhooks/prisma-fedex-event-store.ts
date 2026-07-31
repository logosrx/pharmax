// Prisma-backed implementation of `FedExWebhookEventStore`.
//
// Same concurrency contract as the EasyPost store:
//   - `recordReceived` handles race-on-insert via P2002
//     catch-and-refetch (INSERT … ON CONFLICT DO NOTHING semantics).
//   - The worker claims rows with FOR UPDATE SKIP LOCKED BEFORE
//     calling the mark* methods; this store performs unconditional
//     updates.
//
// PHI: the caller (`handleFedExWebhook`) projects the inbound body
// down to the PHI-free replay subset via
// `projectFedExWebhookForStorage` BEFORE `recordReceived`, so
// shipper/recipient PHI never lands in this RLS-exempt row.

import { Prisma, type FedExWebhookEvent } from "@pharmax/database";

import type { FedExWebhookStoredPayload } from "../carriers/fedex-webhook-payload.js";

import type {
  FedExRecordReceivedInput,
  FedExRecordReceivedResult,
  FedExWebhookEventRecord,
  FedExWebhookEventStatus,
  FedExWebhookEventStore,
} from "./fedex-event-store.js";

export interface FedExWebhookEventClient {
  readonly fedExWebhookEvent: {
    create(args: { data: Prisma.FedExWebhookEventCreateInput }): Promise<FedExWebhookEvent>;
    findUnique(args: {
      where: Prisma.FedExWebhookEventWhereUniqueInput;
    }): Promise<FedExWebhookEvent | null>;
    update(args: {
      where: Prisma.FedExWebhookEventWhereUniqueInput;
      data: Prisma.FedExWebhookEventUpdateInput;
    }): Promise<FedExWebhookEvent>;
  };
}

export class PrismaFedExWebhookEventStore implements FedExWebhookEventStore {
  public constructor(private readonly client: FedExWebhookEventClient) {}

  public async recordReceived(input: FedExRecordReceivedInput): Promise<FedExRecordReceivedResult> {
    const data: Prisma.FedExWebhookEventCreateInput = {
      externalEventId: input.externalEventId,
      eventType: input.eventType,
      trackingNumber: input.trackingNumber,
      carrierStatus: input.carrierStatus,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      status: input.initialStatus,
      receivedAt: input.receivedAt,
      signatureVerifiedAt: input.signatureVerifiedAt,
      processedAt: input.initialStatus === "IGNORED" ? input.receivedAt : null,
    };

    try {
      const created = await this.client.fedExWebhookEvent.create({ data });
      return { record: toRecord(created), inserted: true };
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        const existing = await this.client.fedExWebhookEvent.findUnique({
          where: { externalEventId: input.externalEventId },
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
  ): Promise<FedExWebhookEventRecord | null> {
    const found = await this.client.fedExWebhookEvent.findUnique({
      where: { externalEventId },
    });
    return found === null ? null : toRecord(found);
  }

  public async markProcessing(
    externalEventId: string,
    startedAt: Date
  ): Promise<FedExWebhookEventRecord> {
    const updated = await this.client.fedExWebhookEvent.update({
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
  ): Promise<FedExWebhookEventRecord> {
    const updated = await this.client.fedExWebhookEvent.update({
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
  }): Promise<FedExWebhookEventRecord> {
    const updated = await this.client.fedExWebhookEvent.update({
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

function toRecord(row: FedExWebhookEvent): FedExWebhookEventRecord {
  return Object.freeze({
    id: row.id,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    trackingNumber: row.trackingNumber,
    carrierStatus: row.carrierStatus,
    payload: row.payload as unknown as FedExWebhookStoredPayload,
    status: row.status as FedExWebhookEventStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    receivedAt: row.receivedAt,
    signatureVerifiedAt: row.signatureVerifiedAt,
    processingStartedAt: row.processingStartedAt,
    processedAt: row.processedAt,
    nextAttemptAt: row.nextAttemptAt,
  });
}
