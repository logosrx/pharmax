-- migration: 20260721000000_fedex_webhook_event
--
-- Inbound FedEx Advanced Integrated Visibility (AIV) webhook ledger.
-- Mirrors `easypost_webhook_event`: the HTTP transport handler writes
-- one row per delivery (idempotent on `externalEventId` — a SHA-256
-- digest of the raw body, since FedEx publishes no per-delivery event
-- id); the worker drains PENDING/FAILED rows, resolves each tracking
-- number to a shipment in system context, and dispatches the domain
-- command inside the org's tenancy. RLS-exempt for the same reason as
-- `easypost_webhook_event`: events arrive BEFORE the platform knows
-- which tenant they belong to.
--
-- PHI: the ingestion path projects the body down to a PHI-free
-- replay subset (tracking numbers, scan events, latest status,
-- date/times) BEFORE persisting — account-number AIV subscriptions
-- can carry shipper/recipient address, which must never land in this
-- RLS-exempt row.

CREATE TYPE "FedExWebhookEventStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'IGNORED'
);

CREATE TABLE "fedex_webhook_event" (
    "id" UUID NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "carrierStatus" TEXT,
    "payload" JSONB NOT NULL,
    "status" "FedExWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureVerifiedAt" TIMESTAMP(3) NOT NULL,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    CONSTRAINT "fedex_webhook_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fedex_webhook_event_externalEventId_key"
    ON "fedex_webhook_event"("externalEventId");
CREATE INDEX "fedex_webhook_event_status_nextAttemptAt_idx"
    ON "fedex_webhook_event"("status", "nextAttemptAt");
CREATE INDEX "fedex_webhook_event_trackingNumber_receivedAt_idx"
    ON "fedex_webhook_event"("trackingNumber", "receivedAt");
CREATE INDEX "fedex_webhook_event_receivedAt_idx"
    ON "fedex_webhook_event"("receivedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "fedex_webhook_event" TO pharmax_app, pharmax_system;
