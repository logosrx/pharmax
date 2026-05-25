// In-memory implementation of `EasyPostWebhookEventStore`.
//
// Intended for unit tests and local development against a synthetic
// event stream. NOT safe for production: no durability, no row-level
// locking; concurrent invocations are serialized via a microtask guard
// only. The Prisma-backed implementation in `@pharmax/database`
// is the production store.

import type { EasyPostTrackerWebhookPayload } from "../carriers/easypost-payload.js";

import type {
  EasyPostWebhookEventRecord,
  EasyPostWebhookEventStatus,
  EasyPostWebhookEventStore,
  RecordReceivedInput,
  RecordReceivedResult,
} from "./event-store.js";

interface MutableRecord {
  id: string;
  externalEventId: string;
  eventType: string;
  trackingCode: string | null;
  carrierStatus: string | null;
  payload: EasyPostTrackerWebhookPayload;
  status: EasyPostWebhookEventStatus;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  signatureVerifiedAt: Date;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  nextAttemptAt: Date | null;
}

function freeze(record: MutableRecord): EasyPostWebhookEventRecord {
  return Object.freeze({ ...record });
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `mem-easypost-webhook-event-${counter.toString(16)}`;
}

export class InMemoryEasyPostWebhookEventStore implements EasyPostWebhookEventStore {
  private readonly byExternalEventId = new Map<string, MutableRecord>();

  public async recordReceived(input: RecordReceivedInput): Promise<RecordReceivedResult> {
    const existing = this.byExternalEventId.get(input.event.id);
    if (existing !== undefined) {
      return { record: freeze(existing), inserted: false };
    }
    const record: MutableRecord = {
      id: nextId(),
      externalEventId: input.event.id,
      eventType: input.event.description,
      trackingCode: input.event.result.tracking_code ?? null,
      carrierStatus: input.event.result.status ?? null,
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
    this.byExternalEventId.set(input.event.id, record);
    return { record: freeze(record), inserted: true };
  }

  public async findByExternalEventId(
    externalEventId: string
  ): Promise<EasyPostWebhookEventRecord | null> {
    const found = this.byExternalEventId.get(externalEventId);
    return found === undefined ? null : freeze(found);
  }

  public async markProcessing(
    externalEventId: string,
    startedAt: Date
  ): Promise<EasyPostWebhookEventRecord> {
    const record = this.requireRecord(externalEventId);
    record.status = "PROCESSING";
    record.processingStartedAt = startedAt;
    record.attempts += 1;
    return freeze(record);
  }

  public async markSucceeded(
    externalEventId: string,
    processedAt: Date
  ): Promise<EasyPostWebhookEventRecord> {
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
  }): Promise<EasyPostWebhookEventRecord> {
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
      throw new Error(
        `InMemoryEasyPostWebhookEventStore: unknown externalEventId ${externalEventId}`
      );
    }
    return record;
  }
}
