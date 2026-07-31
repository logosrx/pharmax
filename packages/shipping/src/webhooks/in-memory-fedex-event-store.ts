// In-memory implementation of `FedExWebhookEventStore`. Tests and
// local development only — mirrors the EasyPost in-memory store.

import type { FedExWebhookStoredPayload } from "../carriers/fedex-webhook-payload.js";

import type {
  FedExRecordReceivedInput,
  FedExRecordReceivedResult,
  FedExWebhookEventRecord,
  FedExWebhookEventStatus,
  FedExWebhookEventStore,
} from "./fedex-event-store.js";

interface MutableRecord {
  id: string;
  externalEventId: string;
  eventType: string;
  trackingNumber: string | null;
  carrierStatus: string | null;
  payload: FedExWebhookStoredPayload;
  status: FedExWebhookEventStatus;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  signatureVerifiedAt: Date;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  nextAttemptAt: Date | null;
}

function freeze(record: MutableRecord): FedExWebhookEventRecord {
  return Object.freeze({ ...record });
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `mem-fedex-webhook-event-${counter.toString(16)}`;
}

export class InMemoryFedExWebhookEventStore implements FedExWebhookEventStore {
  private readonly byExternalEventId = new Map<string, MutableRecord>();

  public async recordReceived(input: FedExRecordReceivedInput): Promise<FedExRecordReceivedResult> {
    const existing = this.byExternalEventId.get(input.externalEventId);
    if (existing !== undefined) {
      return { record: freeze(existing), inserted: false };
    }
    const record: MutableRecord = {
      id: nextId(),
      externalEventId: input.externalEventId,
      eventType: input.eventType,
      trackingNumber: input.trackingNumber,
      carrierStatus: input.carrierStatus,
      payload: input.payload,
      status: input.initialStatus,
      attempts: 0,
      lastError: null,
      receivedAt: input.receivedAt,
      signatureVerifiedAt: input.signatureVerifiedAt,
      processingStartedAt: null,
      processedAt: input.initialStatus === "IGNORED" ? input.receivedAt : null,
      nextAttemptAt: null,
    };
    this.byExternalEventId.set(input.externalEventId, record);
    return { record: freeze(record), inserted: true };
  }

  public async findByExternalEventId(
    externalEventId: string
  ): Promise<FedExWebhookEventRecord | null> {
    const found = this.byExternalEventId.get(externalEventId);
    return found === undefined ? null : freeze(found);
  }

  public async markProcessing(
    externalEventId: string,
    startedAt: Date
  ): Promise<FedExWebhookEventRecord> {
    const record = this.requireRecord(externalEventId);
    record.status = "PROCESSING";
    record.processingStartedAt = startedAt;
    record.attempts += 1;
    return freeze(record);
  }

  public async markSucceeded(
    externalEventId: string,
    processedAt: Date
  ): Promise<FedExWebhookEventRecord> {
    const record = this.requireRecord(externalEventId);
    record.status = "SUCCEEDED";
    record.processedAt = processedAt;
    record.lastError = null;
    record.nextAttemptAt = null;
    return freeze(record);
  }

  public async markFailed(input: {
    readonly externalEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<FedExWebhookEventRecord> {
    const record = this.requireRecord(input.externalEventId);
    record.status = "FAILED";
    record.processedAt = input.failedAt;
    record.lastError = input.errorMessage;
    record.nextAttemptAt = input.nextAttemptAt;
    return freeze(record);
  }

  private requireRecord(externalEventId: string): MutableRecord {
    const record = this.byExternalEventId.get(externalEventId);
    if (record === undefined) {
      throw new Error(`InMemoryFedExWebhookEventStore: unknown externalEventId ${externalEventId}`);
    }
    return record;
  }
}
