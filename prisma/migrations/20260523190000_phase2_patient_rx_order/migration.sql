-- =====================================================================
-- PHASE 2: PATIENT / RX / ORDER SCHEMA
--
-- Introduces the first PHI-bearing tables in the platform:
--
--   patient          — patient identity, encrypted PHI + blind-index
--                      search columns + crypto-shred tombstone.
--   provider         — prescriber roster, plain (NPI registry data
--                      is public per Safe Harbor).
--   prescription     — signed Rx; patient↔provider linkage; encrypted
--                      sig/notes; rxNumber + blind-index search.
--   order            — workflow-stateful order with bucket/assignee
--                      pointers, optimistic-lock counter, SLA
--                      deadline, intake source.
--   order_line       — per-Rx fill rows; lot/vial-label FK placeholders
--                      for phase 4.
--
-- Also promotes three placeholder columns that were created in the
-- baseline migration without their target table to real FKs:
--
--   command_log.targetOrderId  -> order(id)  ON DELETE RESTRICT
--   order_event.orderId        -> order(id)  ON DELETE RESTRICT
--   invoice_line.orderId       -> order(id)  ON DELETE RESTRICT
--
-- Tenancy invariant: every new table carries a NOT NULL
-- "organizationId" and is brought under the standard RLS
-- `tenant_isolation` policy at the end of this migration. The
-- `pharmax_app` and `pharmax_system` roles get the appropriate DML
-- grants. No bypass paths.
--
-- Crypto invariant: every `*Enc` column is a JSONB envelope produced
-- by `@pharmax/crypto::encryptField` with AAD bound to (table,
-- column, recordId). The blind-index `*Bi` columns are HMAC outputs
-- using the per-tenant search key for the matching (table, column)
-- purpose (see packages/database/src/phi/blind-index-purposes.ts).
--
-- This migration MUST be followed by `prisma generate` so the
-- @pharmax/database client picks up the new models.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CreateEnum
-- ---------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "PatientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DECEASED', 'MERGED');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DISCONTINUED', 'TRANSFERRED_OUT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM (
  'RECEIVED',
  'TYPING_IN_PROGRESS',
  'TYPED_READY_FOR_PV1',
  'PV1_IN_PROGRESS',
  'PV1_APPROVED_READY_FOR_FILL',
  'FILL_IN_PROGRESS',
  'FILL_COMPLETED_READY_FOR_FINAL',
  'FINAL_VERIFICATION_IN_PROGRESS',
  'FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP',
  'READY_TO_SHIP',
  'SHIPPED',
  'TYPING_PENDING_MISSING_INFO',
  'PV1_REJECTED',
  'FINAL_VERIFICATION_REJECTED',
  'ON_HOLD',
  'CANCELLED'
);

-- CreateEnum
CREATE TYPE "OrderPriority" AS ENUM ('NORMAL', 'RUSH', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "OrderLineStatus" AS ENUM ('PENDING', 'FILLED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "IntakeSourceKind" AS ENUM ('MANUAL', 'CSV', 'API', 'EHR_INTEGRATION', 'TRANSFERRED_IN');

-- ---------------------------------------------------------------------
-- 2. CreateTable
-- ---------------------------------------------------------------------

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,

    -- Required encrypted PHI:
    "firstNameEnc" JSONB NOT NULL,
    "lastNameEnc" JSONB NOT NULL,
    "dateOfBirthEnc" JSONB NOT NULL,

    -- Optional encrypted PHI:
    "middleNameEnc" JSONB,
    "sexAtBirthEnc" JSONB,
    "ssnLast4Enc" JSONB,
    "phoneEnc" JSONB,
    "emailEnc" JSONB,
    "addressLine1Enc" JSONB,
    "addressLine2Enc" JSONB,
    "cityEnc" JSONB,
    "stateEnc" JSONB,
    "postalCodeEnc" JSONB,
    "mrnEnc" JSONB,

    -- Required blind-index columns:
    "lastNameBi" TEXT NOT NULL,
    "firstNameBi" TEXT NOT NULL,
    "dobBi" TEXT NOT NULL,
    "dobYearMonthBi" TEXT NOT NULL,

    -- Optional blind-index columns:
    "phoneLast10Bi" TEXT,
    "emailBi" TEXT,
    "postalCodeBi" TEXT,
    "mrnBi" TEXT,

    "status" "PatientStatus" NOT NULL DEFAULT 'ACTIVE',
    "mergedIntoPatientId" UUID,
    "cryptoShreddedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "npi" TEXT NOT NULL,
    "deaNumber" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "credential" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "providerId" UUID NOT NULL,

    "rxNumber" TEXT NOT NULL,
    "rxNumberBi" TEXT NOT NULL,

    "drugNdc" TEXT NOT NULL,
    "drugName" TEXT NOT NULL,
    "drugStrength" TEXT,
    "drugForm" TEXT,

    "quantityAuthorized" DECIMAL(18,4) NOT NULL,
    "daysSupply" INTEGER NOT NULL,
    "refillsAuthorized" INTEGER NOT NULL,
    "refillsRemaining" INTEGER NOT NULL,
    "originalDateWritten" DATE NOT NULL,
    "expiresAt" DATE NOT NULL,
    "daw" INTEGER NOT NULL DEFAULT 0,

    -- Encrypted PHI:
    "sigEnc" JSONB NOT NULL,
    "noteToPharmacistEnc" JSONB,
    "noteToPatientEnc" JSONB,
    "indicationEnc" JSONB,

    "status" "PrescriptionStatus" NOT NULL DEFAULT 'ACTIVE',

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "patientId" UUID NOT NULL,

    "externalOrderNumber" TEXT,

    "currentStatus" "OrderStatus" NOT NULL,
    "currentBucketId" UUID NOT NULL,
    "currentAssigneeUserId" UUID,
    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,

    "version" INTEGER NOT NULL DEFAULT 0,

    "priority" "OrderPriority" NOT NULL DEFAULT 'NORMAL',
    "slaDeadlineAt" TIMESTAMP(3),

    "intakeSourceKind" "IntakeSourceKind" NOT NULL,
    "intakeSourceRefId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "prescriptionId" UUID NOT NULL,

    "quantityToFill" DECIMAL(18,4) NOT NULL,
    "daysSupplyToFill" INTEGER NOT NULL,

    "lineStatus" "OrderLineStatus" NOT NULL DEFAULT 'PENDING',

    -- Phase 4 placeholders; promoted to FKs when lot/vial_label land.
    "lotId" UUID,
    "vialLabelId" UUID,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. CreateIndex
-- ---------------------------------------------------------------------

-- patient
CREATE INDEX "patient_organizationId_clinicId_status_idx" ON "patient"("organizationId", "clinicId", "status");
CREATE INDEX "patient_organizationId_lastNameBi_idx" ON "patient"("organizationId", "lastNameBi");
CREATE INDEX "patient_organizationId_firstNameBi_idx" ON "patient"("organizationId", "firstNameBi");
CREATE INDEX "patient_organizationId_dobBi_idx" ON "patient"("organizationId", "dobBi");
CREATE INDEX "patient_organizationId_dobYearMonthBi_idx" ON "patient"("organizationId", "dobYearMonthBi");
CREATE INDEX "patient_organizationId_phoneLast10Bi_idx" ON "patient"("organizationId", "phoneLast10Bi");
CREATE INDEX "patient_organizationId_emailBi_idx" ON "patient"("organizationId", "emailBi");
CREATE INDEX "patient_organizationId_postalCodeBi_idx" ON "patient"("organizationId", "postalCodeBi");
CREATE INDEX "patient_organizationId_mrnBi_idx" ON "patient"("organizationId", "mrnBi");
CREATE INDEX "patient_organizationId_mergedIntoPatientId_idx" ON "patient"("organizationId", "mergedIntoPatientId");

-- provider
CREATE UNIQUE INDEX "provider_organizationId_npi_key" ON "provider"("organizationId", "npi");
CREATE INDEX "provider_organizationId_status_idx" ON "provider"("organizationId", "status");
CREATE INDEX "provider_organizationId_lastName_idx" ON "provider"("organizationId", "lastName");
CREATE INDEX "provider_organizationId_deaNumber_idx" ON "provider"("organizationId", "deaNumber");

-- prescription
CREATE UNIQUE INDEX "prescription_organizationId_clinicId_rxNumber_key" ON "prescription"("organizationId", "clinicId", "rxNumber");
CREATE INDEX "prescription_organizationId_patientId_idx" ON "prescription"("organizationId", "patientId");
CREATE INDEX "prescription_organizationId_providerId_idx" ON "prescription"("organizationId", "providerId");
CREATE INDEX "prescription_organizationId_rxNumberBi_idx" ON "prescription"("organizationId", "rxNumberBi");
CREATE INDEX "prescription_organizationId_drugNdc_idx" ON "prescription"("organizationId", "drugNdc");
CREATE INDEX "prescription_organizationId_status_expiresAt_idx" ON "prescription"("organizationId", "status", "expiresAt");

-- order (queue-shaped composite indexes)
CREATE INDEX "order_organizationId_currentBucketId_currentStatus_priority_idx" ON "order"("organizationId", "currentBucketId", "currentStatus", "priority", "slaDeadlineAt", "receivedAt");
CREATE INDEX "order_organizationId_currentAssigneeUserId_currentStatus_idx" ON "order"("organizationId", "currentAssigneeUserId", "currentStatus");
CREATE INDEX "order_organizationId_patientId_idx" ON "order"("organizationId", "patientId");
CREATE INDEX "order_organizationId_externalOrderNumber_idx" ON "order"("organizationId", "externalOrderNumber");
CREATE INDEX "order_organizationId_currentStatus_slaDeadlineAt_idx" ON "order"("organizationId", "currentStatus", "slaDeadlineAt");

-- order_line
CREATE INDEX "order_line_orderId_idx" ON "order_line"("orderId");
CREATE INDEX "order_line_prescriptionId_idx" ON "order_line"("prescriptionId");
CREATE INDEX "order_line_organizationId_lineStatus_idx" ON "order_line"("organizationId", "lineStatus");
CREATE INDEX "order_line_lotId_idx" ON "order_line"("lotId");

-- ---------------------------------------------------------------------
-- 4. AddForeignKey — new tables
-- ---------------------------------------------------------------------

-- patient
ALTER TABLE "patient" ADD CONSTRAINT "patient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient" ADD CONSTRAINT "patient_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient" ADD CONSTRAINT "patient_mergedIntoPatientId_fkey" FOREIGN KEY ("mergedIntoPatientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- provider
ALTER TABLE "provider" ADD CONSTRAINT "provider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- prescription
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- order
ALTER TABLE "order" ADD CONSTRAINT "order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_currentBucketId_fkey" FOREIGN KEY ("currentBucketId") REFERENCES "bucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_currentAssigneeUserId_fkey" FOREIGN KEY ("currentAssigneeUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_workflowPolicyId_fkey" FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- order_line
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. AddForeignKey — placeholder promotions
--
--    These three columns existed in the baseline as raw UUIDs because
--    the `order` table did not yet exist. Now it does, so we promote
--    them to real FKs. The columns themselves keep their names — only
--    a CONSTRAINT is added, so no row data changes.
--
--    Naming follows Prisma's `<table>_<column>_fkey` convention; if
--    a future `prisma migrate diff` regenerates the same constraint
--    it MUST emit the same name to avoid a churn migration.
-- ---------------------------------------------------------------------

ALTER TABLE "command_log"
  ADD CONSTRAINT "command_log_targetOrderId_fkey"
  FOREIGN KEY ("targetOrderId") REFERENCES "order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_event"
  ADD CONSTRAINT "order_event_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_line"
  ADD CONSTRAINT "invoice_line_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 6. Grants for application roles.
--
--    Standard DML on every new tenant table. Mirrors the baseline
--    RLS migration's grant block. Sequence grants are unnecessary
--    here because we use UUID primary keys (no SERIAL sequences),
--    but the baseline already issued
--    `GRANT USAGE ON ALL SEQUENCES … TO pharmax_app, pharmax_system`
--    so future SERIAL columns inherit access automatically.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "patient",
    "provider",
    "prescription",
    "order",
    "order_line"
TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 7. Enable + FORCE row-level security on every new tenant table.
--    Identical shape to the baseline RLS migration — FORCE ensures
--    even the table owner (postgres in dev, pharmax_migrator in
--    prod) is subject to policies, so a manual psql session can't
--    mask misconfigurations.
-- ---------------------------------------------------------------------

ALTER TABLE "patient"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "provider"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider"     FORCE  ROW LEVEL SECURITY;
ALTER TABLE "prescription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescription" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "order"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "order_line"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_line"   FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 8. Policies.
--    One PERMISSIVE `tenant_isolation` policy per table, using the
--    standard `organizationId` predicate. Same shape as the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'patient',
    'provider',
    'prescription',
    'order',
    'order_line'
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
-- 9. Sanity comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE  "patient"      IS
  'Patient identity. PHI columns are envelope-encrypted JSONB (suffix *Enc) with AAD bound to (table, column, id). Searchable PHI is paired with HMAC blind-index TEXT columns (suffix *Bi). When cryptoShreddedAt IS NOT NULL the per-row DEKs are destroyed at the KMS and *Enc reads return tombstones.';
COMMENT ON TABLE  "provider"     IS
  'Prescriber roster. NPI registry data is public per HIPAA Safe Harbor; the patient↔provider linkage that is PHI lives on the prescription row.';
COMMENT ON TABLE  "prescription" IS
  'Signed prescription. sigEnc and *noteEnc are PHI; drug identity (NDC, name, strength, form) is stored plain for indexing and reporting.';
COMMENT ON TABLE  "order"        IS
  'Pharmacy order with workflow state. currentStatus MUST only be mutated by a command handler; version is the optimistic-lock counter.';
COMMENT ON TABLE  "order_line"   IS
  'One fill on an order. lotId and vialLabelId are phase 4 placeholders; the lot/vial_label tables are not yet present.';
COMMENT ON COLUMN "patient"."cryptoShreddedAt" IS
  'Tombstone: when set, this row''s envelope-encrypted columns are permanently unreadable. The row remains for FK integrity. See @pharmax/crypto::planCryptoShred.';
