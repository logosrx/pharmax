-- migration: 20260610000000_phase5_clerk_webhook_event
--
-- Inbound Clerk (identity) webhook delivery ledger. Mirrors the
-- existing `stripe_webhook_event` and `easypost_webhook_event`
-- tables: the HTTP transport handler in
-- `apps/web/app/api/webhooks/clerk/route.ts` writes one row per
-- signature-verified delivery (idempotent on `svixMessageId`),
-- then dispatches the event. A Clerk redelivery (Svix retries on
-- 5xx) hits the unique constraint and the receiver acks 200 fast
-- without re-running the dispatcher.
--
-- RLS-exempt for the same reason as the other two webhook tables:
-- events arrive BEFORE the platform knows which tenant they
-- resolve to. The dispatcher resolves the Pharmax `user` row in
-- system context and writes the audit_log row inside that user's
-- organization tenancy.
--
-- PHI invariant: Clerk events do not carry PHI. Operator identity
-- (id, email, names) is not patient data.

CREATE TYPE "ClerkWebhookEventStatus" AS ENUM (
    'PENDING',
    'APPLIED',
    'NOOP',
    'FAILED'
);

CREATE TABLE "clerk_webhook_event" (
    "id" UUID NOT NULL,
    -- Svix-id header. Stable across Svix retries, so a duplicate
    -- delivery is rejected by the unique index below and the
    -- receiver acks 200 without re-dispatching.
    "svixMessageId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    -- Verbatim payload for forensic replay. Must NEVER be logged.
    "payload" JSONB NOT NULL,
    "status" "ClerkWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    -- Discriminated outcome string from the dispatcher
    -- (`applied`, `noop_no_link`, etc.). Useful for ops triage.
    "dispatchOutcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureVerifiedAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    CONSTRAINT "clerk_webhook_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clerk_webhook_event_svixMessageId_key"
    ON "clerk_webhook_event"("svixMessageId");
CREATE INDEX "clerk_webhook_event_eventType_receivedAt_idx"
    ON "clerk_webhook_event"("eventType", "receivedAt");
CREATE INDEX "clerk_webhook_event_receivedAt_idx"
    ON "clerk_webhook_event"("receivedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "clerk_webhook_event" TO pharmax_app, pharmax_system;
