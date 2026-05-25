-- migration: 20260601000000_phase4_carrier_credential
--
-- Per-tenant carrier credentials for outbound shipping (label
-- purchase) and inbound webhooks. One row per (organizationId,
-- provider) pair — an org has at most one ACTIVE credential per
-- carrier. Disabling a credential is preferred over deletion so
-- audit links from prior shipments stay valid.
--
-- API keys and webhook secrets are envelope-encrypted via
-- @pharmax/crypto (AAD binds {tenantId, table, column, recordId}).
-- The plaintext NEVER hits the row — the writer (RegisterCarrierCredential
-- command) encrypts before insert; the resolver decrypts on demand
-- when building the per-org adapter instance.

CREATE TYPE "ShippingProvider" AS ENUM ('EASYPOST', 'FEDEX', 'UPS');

CREATE TYPE "CarrierCredentialStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "carrier_credential" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" "ShippingProvider" NOT NULL,
    -- Envelope-encrypted API key. apiKeyEnc.binding =
    -- {tenantId: organizationId, table: "carrier_credential",
    --  column: "apiKey", recordId: id}.
    "apiKeyEnc" JSONB NOT NULL,
    -- Envelope-encrypted webhook secret (HMAC key used by the
    -- inbound webhook route to verify signatures). Same binding
    -- shape with column: "webhookSecret".
    "webhookSecretEnc" JSONB,
    -- Optional carrier-specific identifier (FedEx account number,
    -- UPS shipper number, EasyPost carrier_account_id). Stored
    -- plaintext; not PHI and the resolver needs it to scope rates.
    "carrierAccountId" TEXT,
    -- Optional base URL override (sandbox vs production, regional
    -- endpoints). NULL falls back to the adapter's default.
    "baseUrl" TEXT,
    "status" "CarrierCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createCommandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "carrier_credential_pkey" PRIMARY KEY ("id")
);

-- At most one ACTIVE credential per (organizationId, provider).
-- DISABLED rows can coexist for audit history.
CREATE UNIQUE INDEX "carrier_credential_active_unique"
    ON "carrier_credential"("organizationId", "provider")
    WHERE "status" = 'ACTIVE';

CREATE INDEX "carrier_credential_organizationId_provider_status_idx"
    ON "carrier_credential"("organizationId", "provider", "status");

ALTER TABLE "carrier_credential" ADD CONSTRAINT "carrier_credential_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_credential" ADD CONSTRAINT "carrier_credential_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_credential" ADD CONSTRAINT "carrier_credential_createCommandLogId_fkey"
    FOREIGN KEY ("createCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['carrier_credential']
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO pharmax_app, pharmax_system', tbl);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I FOR ALL USING (
                current_setting(''pharmax.system_context'', true) = ''on''
                OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
            ) WITH CHECK (
                current_setting(''pharmax.system_context'', true) = ''on''
                OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
            )',
            tbl
        );
    END LOOP;
END $$;
