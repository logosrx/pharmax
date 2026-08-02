-- WebAuthn second factor (ADR-0036, slice 1).
--
-- Adds:
--   * `webauthn_credential` — a registered authenticator (security key
--     or platform passkey): base64url credential id (globally unique),
--     COSE public key (public by definition — not KMS-sealed), BIGINT
--     signature counter for clone detection, transports, AAGUID, and a
--     user-visible label. Soft-revoked via `disabledAt`, never deleted.
--   * `webauthn_challenge` — single-use, short-TTL ceremony challenge.
--     Verification consumes the row (`consumedAt`) in the same
--     transaction as the cryptographic check, so a challenge can never
--     verify twice.

CREATE TYPE "WebAuthnCeremony" AS ENUM ('REGISTRATION', 'AUTHENTICATION');

CREATE TABLE "webauthn_credential" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "aaguid" TEXT,
    "label" TEXT NOT NULL,

    "lastUsedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webauthn_credential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webauthn_challenge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    "purpose" "WebAuthnCeremony" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webauthn_credential_credentialId_key"
    ON "webauthn_credential"("credentialId");
CREATE INDEX "webauthn_credential_userId_disabledAt_idx"
    ON "webauthn_credential"("userId", "disabledAt");
CREATE INDEX "webauthn_credential_organizationId_idx"
    ON "webauthn_credential"("organizationId");

CREATE INDEX "webauthn_challenge_userId_purpose_idx"
    ON "webauthn_challenge"("userId", "purpose");
CREATE INDEX "webauthn_challenge_organizationId_idx"
    ON "webauthn_challenge"("organizationId");

ALTER TABLE "webauthn_credential"
    ADD CONSTRAINT "webauthn_credential_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webauthn_credential"
    ADD CONSTRAINT "webauthn_credential_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webauthn_challenge"
    ADD CONSTRAINT "webauthn_challenge_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webauthn_challenge"
    ADD CONSTRAINT "webauthn_challenge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webauthn_credential"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webauthn_challenge"
    TO pharmax_app, pharmax_system;

ALTER TABLE "webauthn_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webauthn_credential" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "webauthn_challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webauthn_challenge" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "webauthn_credential"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

CREATE POLICY tenant_isolation ON "webauthn_challenge"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "webauthn_credential" IS
  'Registered WebAuthn authenticator (security key / platform passkey) for an operator (ADR-0036). COSE public key + signature counter; soft-revoked via disabledAt. Written only by ConfirmWebAuthnCredential / SignIn.';
COMMENT ON TABLE "webauthn_challenge" IS
  'Single-use WebAuthn ceremony challenge (ADR-0036). Consumed atomically with verification; expired rows purged opportunistically at mint time.';
