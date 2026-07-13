-- migration: 20260710000000_phase6_auth_engine
--
-- In-house identity engine (ADR-0030). Adds the authentication tables
-- that replace Clerk. The engine owns authentication only; RBAC +
-- tenancy are unchanged.
--
-- Tenant-scoped tables (auth_session, mfa_enrollment, recovery_code,
-- password_history, password_reset_token) carry `organizationId` and
-- are RLS-protected with the standard `tenant_isolation` policy. Sign-in
-- resolution reads them in a system-context frame (the token/email is
-- tenant-less until resolved) — the same pattern the webhook drains use,
-- which the policy's `pharmax.system_context = 'true'` branch allows.
--
-- `login_attempt` is platform-level (RLS-exempt): an attempt against a
-- nonexistent email has no resolvable tenant. Rationale recorded in
-- `prisma/migrations/rls-exempt.txt`.
--
-- PHI invariant: none of these tables hold patient data. Emails and
-- display names are operator identifiers. Secrets are never stored in
-- plaintext (session tokens as SHA-256 hashes, TOTP secrets as
-- @pharmax/crypto envelopes, passwords/recovery codes as Argon2id).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "AuthSessionRevokeReason" AS ENUM (
  'USER_LOGOUT',
  'ADMIN_REVOKED',
  'PASSWORD_CHANGED',
  'MFA_RESET',
  'ROTATED',
  'IDLE_TIMEOUT',
  'ABSOLUTE_TIMEOUT',
  'USER_TERMINATED',
  'SECURITY_EVENT'
);

CREATE TYPE "MfaType" AS ENUM (
  'TOTP'
);

CREATE TYPE "LoginOutcome" AS ENUM (
  'SUCCESS',
  'INVALID_CREDENTIALS',
  'MFA_REQUIRED',
  'MFA_FAILED',
  'LOCKED_OUT',
  'RATE_LIMITED',
  'USER_INACTIVE'
);

-- ---------------------------------------------------------------------------
-- auth_session — opaque, revocable server-side session
-- ---------------------------------------------------------------------------

CREATE TABLE "auth_session" (
  "id"                UUID                      NOT NULL DEFAULT gen_random_uuid(),
  "organizationId"    UUID                      NOT NULL,
  "userId"            UUID                      NOT NULL,
  "tokenHash"         TEXT                      NOT NULL,
  "mfaSatisfied"      BOOLEAN                   NOT NULL DEFAULT false,
  "ipAddress"         TEXT,
  "userAgent"         TEXT,
  "createdAt"         TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActivityAt"    TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idleExpiresAt"     TIMESTAMP(3)              NOT NULL,
  "absoluteExpiresAt" TIMESTAMP(3)              NOT NULL,
  "revokedAt"         TIMESTAMP(3),
  "revokedReason"     "AuthSessionRevokeReason",

  CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_session_tokenHash_key" ON "auth_session"("tokenHash");
CREATE INDEX "auth_session_userId_revokedAt_idx" ON "auth_session"("userId", "revokedAt");
CREATE INDEX "auth_session_organizationId_createdAt_idx" ON "auth_session"("organizationId", "createdAt");
CREATE INDEX "auth_session_absoluteExpiresAt_idx" ON "auth_session"("absoluteExpiresAt");

ALTER TABLE "auth_session"
  ADD CONSTRAINT "auth_session_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "auth_session"
  ADD CONSTRAINT "auth_session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

ALTER TABLE "auth_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_session" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "auth_session"
  USING (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- ---------------------------------------------------------------------------
-- mfa_enrollment — TOTP authenticator (secret stored as KMS envelope)
-- ---------------------------------------------------------------------------

CREATE TABLE "mfa_enrollment" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organizationId"   UUID         NOT NULL,
  "userId"           UUID         NOT NULL,
  "type"             "MfaType"    NOT NULL DEFAULT 'TOTP',
  "secretCiphertext" TEXT         NOT NULL,
  "verifiedAt"       TIMESTAMP(3),
  "disabledAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "mfa_enrollment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mfa_enrollment_userId_idx" ON "mfa_enrollment"("userId");
-- At most one ACTIVE (non-disabled) enrollment per user. Prisma cannot
-- express partial unique indexes; declared here and mirrored in the
-- @pharmax/auth enrollment command. Recorded in drift-baseline.txt.
CREATE UNIQUE INDEX "mfa_enrollment_active_unique"
  ON "mfa_enrollment"("userId") WHERE "disabledAt" IS NULL;

ALTER TABLE "mfa_enrollment"
  ADD CONSTRAINT "mfa_enrollment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "mfa_enrollment"
  ADD CONSTRAINT "mfa_enrollment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

ALTER TABLE "mfa_enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_enrollment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mfa_enrollment"
  USING (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- ---------------------------------------------------------------------------
-- recovery_code — single-use MFA recovery codes (Argon2id hashes)
-- ---------------------------------------------------------------------------

CREATE TABLE "recovery_code" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID         NOT NULL,
  "userId"         UUID         NOT NULL,
  "codeHash"       TEXT         NOT NULL,
  "usedAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recovery_code_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recovery_code_userId_usedAt_idx" ON "recovery_code"("userId", "usedAt");

ALTER TABLE "recovery_code"
  ADD CONSTRAINT "recovery_code_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "recovery_code"
  ADD CONSTRAINT "recovery_code_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

ALTER TABLE "recovery_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_code" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recovery_code"
  USING (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- ---------------------------------------------------------------------------
-- password_history — anti-reuse window (Argon2id hashes)
-- ---------------------------------------------------------------------------

CREATE TABLE "password_history" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID         NOT NULL,
  "userId"         UUID         NOT NULL,
  "hashedPassword" TEXT         NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_history_userId_createdAt_idx" ON "password_history"("userId", "createdAt");

ALTER TABLE "password_history"
  ADD CONSTRAINT "password_history_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "password_history"
  ADD CONSTRAINT "password_history_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

ALTER TABLE "password_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "password_history"
  USING (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- ---------------------------------------------------------------------------
-- password_reset_token — short-lived, single-use (SHA-256 hash stored)
-- ---------------------------------------------------------------------------

CREATE TABLE "password_reset_token" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID         NOT NULL,
  "userId"         UUID         NOT NULL,
  "tokenHash"      TEXT         NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "usedAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_token_tokenHash_key" ON "password_reset_token"("tokenHash");
CREATE INDEX "password_reset_token_userId_idx" ON "password_reset_token"("userId");

ALTER TABLE "password_reset_token"
  ADD CONSTRAINT "password_reset_token_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "password_reset_token"
  ADD CONSTRAINT "password_reset_token_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "password_reset_token"
  USING (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'true'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- ---------------------------------------------------------------------------
-- login_attempt — platform-level sign-in ledger (RLS-exempt, pre-tenant)
-- ---------------------------------------------------------------------------

CREATE TABLE "login_attempt" (
  "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID,
  "emailAttempted" TEXT           NOT NULL,
  "outcome"        "LoginOutcome" NOT NULL,
  "reasonCode"     TEXT,
  "ipAddress"      TEXT,
  "userAgent"      TEXT,
  "createdAt"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "login_attempt_emailAttempted_createdAt_idx" ON "login_attempt"("emailAttempted", "createdAt");
CREATE INDEX "login_attempt_ipAddress_createdAt_idx" ON "login_attempt"("ipAddress", "createdAt");
CREATE INDEX "login_attempt_createdAt_idx" ON "login_attempt"("createdAt");

-- RLS-exempt (see rls-exempt.txt): pre-tenant by construction.

-- ---------------------------------------------------------------------------
-- Grants. `pharmax_app` is the RLS-subject app role; `pharmax_system`
-- is used by system-context frames. Matches the webhook-ledger grants.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_session"          TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mfa_enrollment"        TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recovery_code"         TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "password_history"      TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "password_reset_token"  TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "login_attempt"         TO pharmax_app, pharmax_system;
