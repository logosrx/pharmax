// Persistence contract for the `easypost_webhook_event` ledger row.
//
// Defined here so the pipeline (`@pharmax/shipping`) stays free of any
// ORM dependency. The Prisma-backed implementation lives in
// `@pharmax/database/shipping` and is wired by the transport handler in
// `apps/web` and the drain in `apps/worker`.
//
// Semantics mirror the Stripe webhook store one-for-one:
//   - `recordReceived` MUST be idempotent on `externalEventId`. The
//     expected SQL pattern is INSERT … ON CONFLICT (externalEventId) DO
//     NOTHING, returning a flag indicating whether a new row was created.
//   - `markProcessing`, `markSucceeded`, `markFailed` are called by the
//     worker that drains pending rows — NOT by the webhook transport.

import type { EasyPostTrackerWebhookPayload } from "../carriers/easypost-payload.js";

export type EasyPostWebhookEventStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "IGNORED";

export interface EasyPostWebhookEventRecord {
  readonly id: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly trackingCode: string | null;
  readonly carrierStatus: string | null;
  readonly payload: EasyPostTrackerWebhookPayload;
  readonly status: EasyPostWebhookEventStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly processingStartedAt: Date | null;
  readonly processedAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

export interface RecordReceivedInput {
  readonly event: EasyPostTrackerWebhookPayload;
  readonly receivedAt: Date;
  readonly signatureVerifiedAt: Date;
  readonly initialStatus: Extract<EasyPostWebhookEventStatus, "PENDING" | "IGNORED">;
}

export interface RecordReceivedResult {
  readonly record: EasyPostWebhookEventRecord;
  readonly inserted: boolean;
}

export interface EasyPostWebhookEventStore {
  recordReceived(input: RecordReceivedInput): Promise<RecordReceivedResult>;
  findByExternalEventId(externalEventId: string): Promise<EasyPostWebhookEventRecord | null>;
  markProcessing(externalEventId: string, startedAt: Date): Promise<EasyPostWebhookEventRecord>;
  markSucceeded(externalEventId: string, processedAt: Date): Promise<EasyPostWebhookEventRecord>;
  markFailed(input: {
    readonly externalEventId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date | null;
  }): Promise<EasyPostWebhookEventRecord>;
}
