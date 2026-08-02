-- Provider self-serve onboarding (ADR-0033).
--
-- Adds:
--   * `organization.providerOnboardingEnabled` — opt-in gate for the
--     public apply endpoint (off by default; no cross-org discovery).
--   * `provider_onboarding_application` — the workflow-governed
--     application aggregate, org-scoped + RLS-protected.
--   * Partial UNIQUE enforcing at most one OPEN (SUBMITTED /
--     NEEDS_REVIEW) application per (organization, npi); rejected
--     applicants may reapply.

-- Opt-in flag on organization.
ALTER TABLE "organization"
    ADD COLUMN "providerOnboardingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Enums.
CREATE TYPE "ProviderOnboardingStatus" AS ENUM (
    'SUBMITTED',
    'NEEDS_REVIEW',
    'APPROVED',
    'REJECTED'
);

CREATE TYPE "ProviderOnboardingProofingOutcome" AS ENUM (
    'PASS',
    'NOT_FOUND',
    'NOT_INDIVIDUAL',
    'DEACTIVATED',
    'NAME_MISMATCH',
    'ALREADY_REGISTERED',
    'REGISTRY_UNAVAILABLE'
);

-- Application table.
CREATE TABLE "provider_onboarding_application" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "npi" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "credential" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,

    "status" "ProviderOnboardingStatus" NOT NULL DEFAULT 'SUBMITTED',

    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,

    "proofingOutcome" "ProviderOnboardingProofingOutcome",
    "proofingSnapshot" JSONB,
    "proofedAt" TIMESTAMP(3),
    "proofingAttempts" INTEGER NOT NULL DEFAULT 0,

    "providerId" UUID,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionReasonCode" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_onboarding_application_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "provider_onboarding_application"
    ADD CONSTRAINT "provider_onboarding_application_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_onboarding_application"
    ADD CONSTRAINT "provider_onboarding_application_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_onboarding_application"
    ADD CONSTRAINT "provider_onboarding_application_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_onboarding_application"
    ADD CONSTRAINT "provider_onboarding_application_decidedByUserId_fkey"
    FOREIGN KEY ("decidedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "provider_onboarding_application_organizationId_status_crea_idx"
    ON "provider_onboarding_application"("organizationId", "status", "createdAt" DESC);
CREATE INDEX "provider_onboarding_application_organizationId_npi_idx"
    ON "provider_onboarding_application"("organizationId", "npi");
-- Cross-org claim index for the proofing drain (system context).
CREATE INDEX "provider_onboarding_application_status_proofingAttempts_cr_idx"
    ON "provider_onboarding_application"("status", "proofingAttempts", "createdAt");

-- At most one open application per prescriber per org. Prisma
-- cannot express partial indexes; documented on the model.
CREATE UNIQUE INDEX "provider_onboarding_application_open_unique"
    ON "provider_onboarding_application"("organizationId", "npi")
    WHERE "status" IN ('SUBMITTED', 'NEEDS_REVIEW');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "provider_onboarding_application"
    TO pharmax_app, pharmax_system;

-- RLS: standard tenant-isolation policy (same shape as api_key /
-- webhook_subscription in 20260724000000).
ALTER TABLE "provider_onboarding_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_onboarding_application" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "provider_onboarding_application"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "provider_onboarding_application" IS
  'Prescriber self-serve onboarding application (ADR-0033). Workflow-governed: pins the provider.onboarding policy id + version; transitions only through commands. NPPES proofing evidence stored on the row; contains no PHI (NPI + office contact are public professional data).';
