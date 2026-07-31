-- migration: 20260724000000_platform_api_keys_webhooks
--
-- Platform surface P0 (ADR-0032): partner API keys + outbound
-- webhook subscriptions + the webhook delivery ledger.
--
--   api_key              — hashed bearer credential for /api/v1/*.
--   webhook_subscription — partner endpoint + event-type filter +
--                          envelope-encrypted HMAC signing secret.
--   webhook_delivery     — one row per (subscription, outbox event);
--                          claim/lease drained by the worker, doubles
--                          as the partner-visible dead-letter view.
--
-- Secrets at rest:
--   - api_key stores ONLY the SHA-256 hash of the raw token (the
--     raw `pxk_...` secret exists only in the mint response).
--   - webhook_subscription.secretEnc is a @pharmax/crypto
--     ciphertext envelope; plaintext is returned once at creation.
--
-- PHI: none of the three tables carries PHI. webhook_delivery
-- payloads are registry-validated events (phiSafe: true only).
--
-- RLS: all three tables are org-scoped with NON-NULLABLE
-- organizationId → standard ENABLE + FORCE + tenant_isolation
-- policy. api_key resolution happens pre-tenant (bearer token
-- arrives before the org is known) via a system-context frame,
-- mirroring auth_session.

-- ---------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------

CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TYPE "WebhookSubscriptionStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD');

-- ---------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------

CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- SHA-256 (hex) of the raw bearer token. Unique → O(1) resolution.
    "tokenHash" TEXT NOT NULL,
    -- Display prefix (e.g. `pxk_3fA9`) so operators can identify a
    -- key without ever seeing the secret again.
    "tokenPrefix" TEXT NOT NULL,
    -- Permission codes this key may exercise (subset of the RBAC
    -- registry; validated at the command layer).
    "scopes" TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createCommandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_subscription" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    -- Partner endpoint. HTTPS-only, validated at the command layer.
    "url" TEXT NOT NULL,
    -- Envelope-encrypted HMAC-SHA-256 signing secret (`pxw_...`).
    "secretEnc" JSONB NOT NULL,
    -- Versioned registry event names (phiSafe only, validated at
    -- the command layer).
    "eventTypes" TEXT[],
    "description" TEXT,
    "status" "WebhookSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "disabledAt" TIMESTAMP(3),
    "createdByUserId" UUID NOT NULL,
    "createCommandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_delivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    -- Source event_outbox row id — with subscriptionId this is the
    -- fan-out idempotency anchor (outbox retries cannot double-book
    -- a delivery).
    "outboxEventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    -- Registry-validated, PHI-redacted payload snapshot. Keeps the
    -- ledger self-contained for replay + the dead-letter view.
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "responseStatus" INTEGER,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "api_key_tokenHash_key" ON "api_key"("tokenHash");
CREATE INDEX "api_key_organizationId_status_idx" ON "api_key"("organizationId", "status");

CREATE INDEX "webhook_subscription_organizationId_status_idx"
    ON "webhook_subscription"("organizationId", "status");

CREATE UNIQUE INDEX "webhook_delivery_subscriptionId_outboxEventId_key"
    ON "webhook_delivery"("subscriptionId", "outboxEventId");
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx"
    ON "webhook_delivery"("status", "nextAttemptAt");
CREATE INDEX "webhook_delivery_organizationId_createdAt_idx"
    ON "webhook_delivery"("organizationId", "createdAt" DESC);
CREATE INDEX "webhook_delivery_organizationId_eventType_createdAt_idx"
    ON "webhook_delivery"("organizationId", "eventType", "createdAt" DESC);

-- ---------------------------------------------------------------------
-- 4. Foreign keys. RESTRICT on audit anchors (creator user, command
--    log, organization); CASCADE deliveries under their subscription
--    (a revoked-and-purged subscription takes its ledger with it —
--    the audit trail of the revocation itself lives in audit_log).
-- ---------------------------------------------------------------------

ALTER TABLE "api_key"
    ADD CONSTRAINT "api_key_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "api_key"
    ADD CONSTRAINT "api_key_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "api_key"
    ADD CONSTRAINT "api_key_createCommandLogId_fkey"
    FOREIGN KEY ("createCommandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_subscription"
    ADD CONSTRAINT "webhook_subscription_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_subscription"
    ADD CONSTRAINT "webhook_subscription_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_subscription"
    ADD CONSTRAINT "webhook_subscription_createCommandLogId_fkey"
    FOREIGN KEY ("createCommandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_delivery"
    ADD CONSTRAINT "webhook_delivery_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_delivery"
    ADD CONSTRAINT "webhook_delivery_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Grants for application roles. Mirrors the baseline.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "api_key"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_subscription"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_delivery"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 6. Enable + FORCE row-level security, then the standard
--    tenant_isolation policy on all three tables.
-- ---------------------------------------------------------------------

ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_key" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "webhook_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_subscription" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "webhook_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_delivery" FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'api_key',
    'webhook_subscription',
    'webhook_delivery'
  ];
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ') '
      'WITH CHECK ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ');',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- 7. Sanity comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "api_key" IS
  'Partner API key for the public v1 API (ADR-0032). Stores only the SHA-256 hash of the raw pxk_ bearer token; scopes are RBAC permission codes. Resolution runs in a system-context frame (pre-tenant), then all work executes inside the resolved org tenancy.';

COMMENT ON TABLE "webhook_subscription" IS
  'Outbound webhook subscription (ADR-0032). Partner HTTPS endpoint + phi-safe registry event-type filter + envelope-encrypted HMAC signing secret (plaintext returned once at creation).';

COMMENT ON TABLE "webhook_delivery" IS
  'Outbound webhook delivery ledger (ADR-0032). One row per (subscription, outbox event); claim/lease drained by the worker with retry/backoff → DEAD. Doubles as the partner-visible delivery history and dead-letter view.';
