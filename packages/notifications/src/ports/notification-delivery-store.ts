// NotificationDeliveryStore — persistence port for the
// `notification_delivery` projection.
//
// The `PersistentNotificationChannel` decorator calls this port to
// record the lifecycle of every tenant-scoped send:
//
//   recordQueued  → one row in QUEUED before the transport call
//   markSent      → advance to SENT + capture the transport's
//                   provider message id (Resend `email_id`)
//   markFailed    → advance to FAILED + capture the reason
//
// The port is intentionally Prisma-free + tenancy-free so the
// @pharmax/notifications package stays a leaf (its only deps are
// @pharmax/platform-core + zod). The production binding lives in
// the consuming app (`apps/worker`) where Prisma + the tenancy
// GUC helpers are already in scope — that also sidesteps the
// `tenancy → database` dependency direction (a Prisma store here
// would invert it).
//
// Idempotency contract: `recordQueued` MUST be an upsert on
// (organizationId, idempotencyKey). A retried send (same key)
// re-enters QUEUED on the SAME row rather than inserting a
// duplicate — mirrors the transport's own idempotency-key dedupe.

export interface NotificationDeliveryRecordQueuedInput {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly template: string;
  readonly channelName: string;
  readonly recipientKind: string;
  readonly recipientAddress: string;
  /** Opaque caller correlation (today: reportRunId). */
  readonly correlationId?: string;
}

export interface NotificationDeliveryMarkSentInput {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  /** Resend `email_id` — the webhook's join key. */
  readonly providerMessageId: string;
}

export interface NotificationDeliveryMarkFailedInput {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly failureReason: string;
}

export interface NotificationDeliveryStore {
  recordQueued(input: NotificationDeliveryRecordQueuedInput): Promise<void>;
  markSent(input: NotificationDeliveryMarkSentInput): Promise<void>;
  markFailed(input: NotificationDeliveryMarkFailedInput): Promise<void>;
}
