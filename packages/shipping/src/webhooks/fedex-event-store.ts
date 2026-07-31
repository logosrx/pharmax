// Persistence contract for the `fedex_webhook_event` ledger row.
//
// Mirrors `event-store.ts` (EasyPost) one-for-one; kept separate so
// the two inboxes can evolve independently. Semantics:
//   - `recordReceived` MUST be idempotent on `externalEventId` (a
//     SHA-256 digest of the raw body — FedEx publishes no
//     per-delivery event id).
//   - `markProcessing` / `markSucceeded` / `markFailed` are called
//     by the worker drain, never by the webhook transport.

import type { FedExWebhookStoredPayload } from "../carriers/fedex-webhook-payload.js";

export type FedExWebhookEventStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "IGNORED";

export interface FedExWebhookEventRecord {
  readonly id: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly trackingNumber: string | null;
  readonly carrierStatus: string | null;
  readonly payload: FedExWebhookStoredPayload;
  readonly status: FedExWebhookEventStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly processingStartedAt: Date | null;
  readonly processedAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

export interface FedExRecordReceivedInput {
  readonly externalEventId: string;
  readonly eventType: string;
  /** First entry's tracking number, for the inbox triage index. */
  readonly trackingNumber: string | null;
  /** First entry's latest status code, for the inbox triage view. */
  readonly carrierStatus: string | null;
  readonly payload: FedExWebhookStoredPayload;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly initialStatus: Extract<FedExWebhookEventStatus, "PENDING" | "IGNORED">;
}

export interface FedExRecordReceivedResult {
  readonly record: FedExWebhookEventRecord;
  readonly inserted: boolean;
}

export interface FedExWebhookEventStore {
  recordReceived(input: FedExRecordReceivedInput): Promise<FedExRecordReceivedResult>;
  findByExternalEventId(externalEventId: string): Promise<FedExWebhookEventRecord | null>;
  markProcessing(externalEventId: string, startedAt: Date): Promise<FedExWebhookEventRecord>;
  markSucceeded(externalEventId: string, processedAt: Date): Promise<FedExWebhookEventRecord>;
  markFailed(input: {
    readonly externalEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<FedExWebhookEventRecord>;
}
