-- migration: 20260618000000_phase5_notification_delivery
--
-- Two tables closing the notification observability loop:
--
--   1. `notification_delivery` — one row per attempted notification
--      send. Written by the `PersistentNotificationChannel`
--      decorator (QUEUED before the transport call, SENT after the
--      transport accepts and returns its message id), then advanced
--      by the Resend delivery webhook (DELIVERED / BOUNCED /
--      COMPLAINED / DELIVERY_DELAYED) and stamped with the last
--      engagement event. Upsert anchor: (organizationId,
--      idempotencyKey) — the same key the channel dedupes on, so a
--      retried send collapses onto one row. The webhook looks the
--      row up by `providerMessageId` (Resend `email_id`) — globally
--      unique (partial) so a cross-tenant system-context lookup is a
--      single findUnique.
--
--   2. `resend_webhook_event` — the idempotency ledger for inbound
--      Resend webhooks. Same shape + rationale as
--      `clerk_webhook_event`: events arrive Svix-signed, BEFORE we
--      know which tenant they resolve to, so the table is RLS-exempt
--      and the `svixMessageId` unique constraint is the dedupe.
--
-- PHI invariant: recipient addresses are operator/admin emails
-- (NOT patient identifiers). No PHI columns here.

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'QUEUED',
  'SENT',
  'DELIVERED',
  'DELIVERY_DELAYED',
  'BOUNCED',
  'COMPLAINED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "ResendWebhookEventStatus" AS ENUM (
  'PENDING',
  'APPLIED',
  'NOOP',
  'FAILED'
);

CREATE TABLE "notification_delivery" (
  "id"                UUID                          NOT NULL DEFAULT gen_random_uuid(),
  "organizationId"    UUID                          NOT NULL,
  "template"          TEXT                          NOT NULL,
  "channelName"       TEXT                          NOT NULL,
  "recipientKind"     TEXT                          NOT NULL,
  "recipientAddress"  TEXT                          NOT NULL,
  "idempotencyKey"    TEXT                          NOT NULL,
  "providerMessageId" TEXT,
  "correlationId"     TEXT,
  "status"            "NotificationDeliveryStatus"  NOT NULL DEFAULT 'QUEUED',
  "lastEventType"     TEXT,
  "lastEventAt"       TIMESTAMP(3),
  "failureReason"     TEXT,
  "createdAt"         TIMESTAMP(3)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)                  NOT NULL,

  CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_delivery_org_idempotency_idx"
  ON "notification_delivery"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "notification_delivery_provider_msg_key"
  ON "notification_delivery"("providerMessageId");
CREATE INDEX "notification_delivery_org_created_idx"
  ON "notification_delivery"("organizationId", "createdAt" DESC);

ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "notification_delivery_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;

ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_delivery" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "notification_delivery"
  USING (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

CREATE TABLE "resend_webhook_event" (
  "id"                  UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "svixMessageId"       TEXT                       NOT NULL,
  "eventType"           TEXT                       NOT NULL,
  "payload"             JSONB                      NOT NULL,
  "status"              "ResendWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
  "dispatchOutcome"     TEXT,
  "attempts"            INTEGER                    NOT NULL DEFAULT 0,
  "lastError"           TEXT,
  "receivedAt"          TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "signatureVerifiedAt" TIMESTAMP(3)               NOT NULL,
  "dispatchedAt"        TIMESTAMP(3),

  CONSTRAINT "resend_webhook_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resend_webhook_event_svix_message_idx"
  ON "resend_webhook_event"("svixMessageId");
CREATE INDEX "resend_webhook_event_type_received_idx"
  ON "resend_webhook_event"("eventType", "receivedAt");

-- RLS-exempt (no organizationId): identical rationale to
-- clerk_webhook_event / stripe_webhook_event / easypost_webhook_event.
