-- Provider portal principals (ADR-0033, slice 2).
--
-- Adds:
--   * `portal_account`      — the prescriber portal credential; a
--     SEPARATE principal model from `user` (resolves to `provider`,
--     never to an operator).
--   * `portal_session`      — stateful opaque portal sessions (twin
--     of `auth_session`; separate table so the operator session
--     engine can never resolve a portal token).
--   * `portal_setup_token`  — single-use credential-setup tokens
--     (twin of `password_reset_token`).
--
-- All three are org-scoped and RLS-protected.

CREATE TYPE "PortalAccountStatus" AS ENUM (
    'PENDING_SETUP',
    'ACTIVE',
    'DISABLED'
);

-- ---------------------------------------------------------------------------
-- portal_account
-- ---------------------------------------------------------------------------

CREATE TABLE "portal_account" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "applicationId" UUID,

    "email" TEXT NOT NULL,
    "hashedPassword" TEXT,
    "status" "PortalAccountStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "lastLoginAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_account_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portal_account"
    ADD CONSTRAINT "portal_account_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portal_account"
    ADD CONSTRAINT "portal_account_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portal_account"
    ADD CONSTRAINT "portal_account_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "provider_onboarding_application"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "portal_account_providerId_key"
    ON "portal_account"("providerId");
CREATE UNIQUE INDEX "portal_account_organizationId_email_key"
    ON "portal_account"("organizationId", "email");
CREATE INDEX "portal_account_organizationId_status_idx"
    ON "portal_account"("organizationId", "status");

-- ---------------------------------------------------------------------------
-- portal_session
-- ---------------------------------------------------------------------------

CREATE TABLE "portal_session" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "portalAccountId" UUID NOT NULL,

    "tokenHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "AuthSessionRevokeReason",

    CONSTRAINT "portal_session_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portal_session"
    ADD CONSTRAINT "portal_session_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portal_session"
    ADD CONSTRAINT "portal_session_portalAccountId_fkey"
    FOREIGN KEY ("portalAccountId") REFERENCES "portal_account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "portal_session_tokenHash_key"
    ON "portal_session"("tokenHash");
CREATE INDEX "portal_session_portalAccountId_revokedAt_idx"
    ON "portal_session"("portalAccountId", "revokedAt");
CREATE INDEX "portal_session_organizationId_createdAt_idx"
    ON "portal_session"("organizationId", "createdAt");
CREATE INDEX "portal_session_absoluteExpiresAt_idx"
    ON "portal_session"("absoluteExpiresAt");

-- ---------------------------------------------------------------------------
-- portal_setup_token
-- ---------------------------------------------------------------------------

CREATE TABLE "portal_setup_token" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "portalAccountId" UUID NOT NULL,

    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_setup_token_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portal_setup_token"
    ADD CONSTRAINT "portal_setup_token_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portal_setup_token"
    ADD CONSTRAINT "portal_setup_token_portalAccountId_fkey"
    FOREIGN KEY ("portalAccountId") REFERENCES "portal_account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "portal_setup_token_tokenHash_key"
    ON "portal_setup_token"("tokenHash");
CREATE INDEX "portal_setup_token_portalAccountId_idx"
    ON "portal_setup_token"("portalAccountId");
CREATE INDEX "portal_setup_token_organizationId_idx"
    ON "portal_setup_token"("organizationId");

-- ---------------------------------------------------------------------------
-- Grants + RLS (standard tenant-isolation policy, literal form)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "portal_account"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "portal_session"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "portal_setup_token"
    TO pharmax_app, pharmax_system;

ALTER TABLE "portal_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_account" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "portal_account"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

ALTER TABLE "portal_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_session" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "portal_session"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

ALTER TABLE "portal_setup_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_setup_token" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "portal_setup_token"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "portal_account" IS
  'Prescriber portal credential (ADR-0033 slice 2). A separate principal model from user: resolves to provider, never to an operator. Argon2id hash; NULL until the one-time setup link is consumed.';
COMMENT ON TABLE "portal_session" IS
  'Stateful opaque portal session (twin of auth_session). Sliding idle + absolute expiry; immediate revocation. A portal token can never resolve an operator session or vice versa.';
COMMENT ON TABLE "portal_setup_token" IS
  'Single-use portal credential-setup token (twin of password_reset_token). Only the SHA-256 hash is stored; the raw token lives only in the emailed setup link.';
