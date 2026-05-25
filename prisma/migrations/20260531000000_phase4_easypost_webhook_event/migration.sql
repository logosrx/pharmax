-- migration: 20260531000000_phase4_easypost_webhook_event
--
-- Inbound EasyPost webhook ledger. Mirrors `stripe_webhook_event`:
-- the HTTP transport handler writes one row per delivery (idempotent
-- on `externalEventId`); the worker drains PENDING/FAILED rows,
-- resolves the shipment in system context, and dispatches the
-- domain command inside the org's tenancy. RLS-exempt for the same
-- reason as `stripe_webhook_event`: events arrive BEFORE the
-- platform knows which tenant they belong to.

CREATE TYPE "EasyPostWebhookEventStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'IGNORED'
);

CREATE TABLE "easypost_webhook_event" (
    "id" UUID NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "trackingCode" TEXT,
    "carrierStatus" TEXT,
    -- Raw payload as received from EasyPost. Stored verbatim so the
    -- worker can replay processing without re-fetching from EasyPost.
    -- No PHI — EasyPost tracker payloads contain carrier metadata
    -- and (possibly) recipient name + address. Recipient PHI is NOT
    -- written to the audit_log; it lives only in this raw ledger.
    "payload" JSONB NOT NULL,
    "status" "EasyPostWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureVerifiedAt" TIMESTAMP(3) NOT NULL,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    CONSTRAINT "easypost_webhook_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "easypost_webhook_event_externalEventId_key"
    ON "easypost_webhook_event"("externalEventId");
CREATE INDEX "easypost_webhook_event_status_nextAttemptAt_idx"
    ON "easypost_webhook_event"("status", "nextAttemptAt");
CREATE INDEX "easypost_webhook_event_trackingCode_receivedAt_idx"
    ON "easypost_webhook_event"("trackingCode", "receivedAt");
CREATE INDEX "easypost_webhook_event_receivedAt_idx"
    ON "easypost_webhook_event"("receivedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "easypost_webhook_event" TO pharmax_app, pharmax_system;
