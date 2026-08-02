-- Compounding domain, slice 2 (ADR-0035).
--
-- Adds:
--   * `COMPOUND_CONSUMED` on InventoryTransactionReason — ingredient
--     lot consumption by a compounding preparation (distinct from
--     LOT_ASSIGNED, which means "dispensed lot bound to a line").
--   * `compounding_record` — the per-preparation USP <795>/<797>
--     Compounding Record, written at the FILL stage: preparer, pinned
--     formula version, computed BUD, USP <800> handling notes, QC
--     outcome, and the rendered human-readable record document
--     (in-row, PrintJob.renderedZpl precedent).
--   * `compounding_record_ingredient` — consumed components with a
--     Lot FK when product-backed, or a manual lot number for bulk
--     chemicals.
--
-- The rendered document contains order/rx identifiers (PHI-adjacent);
-- both tables are RLS'd like every tenant table.

ALTER TYPE "InventoryTransactionReason" ADD VALUE 'COMPOUND_CONSUMED';

CREATE TYPE "CompoundingQualityOutcome" AS ENUM (
    'PASS',
    'FAIL'
);

-- Compounding record.
CREATE TABLE "compounding_record" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,

    "formulaId" UUID NOT NULL,
    "formulaCode" TEXT NOT NULL,
    "formulaVersion" INTEGER NOT NULL,

    "preparedByUserId" UUID NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL,

    "budAt" TIMESTAMP(3) NOT NULL,
    "storageCondition" "CompoundStorageCondition" NOT NULL,

    "hazardous" BOOLEAN NOT NULL,
    "handlingNotes" TEXT,

    "qualityOutcome" "CompoundingQualityOutcome" NOT NULL,
    "qualityNotes" TEXT,

    "workflowPolicyId" UUID NOT NULL,
    "workflowPolicyVersion" INTEGER NOT NULL,

    "renderedDocument" TEXT NOT NULL,
    "documentSha256" BYTEA NOT NULL,

    "commandLogId" UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compounding_record_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_formulaId_fkey"
    FOREIGN KEY ("formulaId") REFERENCES "compound_formula"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_preparedByUserId_fkey"
    FOREIGN KEY ("preparedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_workflowPolicyId_fkey"
    FOREIGN KEY ("workflowPolicyId") REFERENCES "workflow_policy"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record"
    ADD CONSTRAINT "compounding_record_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "compounding_record_organizationId_orderId_idx"
    ON "compounding_record"("organizationId", "orderId");
CREATE INDEX "compounding_record_organizationId_orderLineId_idx"
    ON "compounding_record"("organizationId", "orderLineId");
CREATE INDEX "compounding_record_organizationId_formulaId_preparedAt_idx"
    ON "compounding_record"("organizationId", "formulaId", "preparedAt");

-- Consumed components.
CREATE TABLE "compounding_record_ingredient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "recordId" UUID NOT NULL,

    "formulaIngredientId" UUID NOT NULL,
    "ingredientName" TEXT NOT NULL,

    "lotId" UUID,
    "manualLotNumber" TEXT,
    "manualExpirationDate" DATE,

    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compounding_record_ingredient_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "compounding_record_ingredient"
    ADD CONSTRAINT "compounding_record_ingredient_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record_ingredient"
    ADD CONSTRAINT "compounding_record_ingredient_recordId_fkey"
    FOREIGN KEY ("recordId") REFERENCES "compounding_record"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record_ingredient"
    ADD CONSTRAINT "compounding_record_ingredient_formulaIngredientId_fkey"
    FOREIGN KEY ("formulaIngredientId") REFERENCES "compound_formula_ingredient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compounding_record_ingredient"
    ADD CONSTRAINT "compounding_record_ingredient_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "lot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "compounding_record_ingredient_recordId_idx"
    ON "compounding_record_ingredient"("recordId");
CREATE INDEX "compounding_record_ingredient_organizationId_lotId_idx"
    ON "compounding_record_ingredient"("organizationId", "lotId");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "compounding_record"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "compounding_record_ingredient"
    TO pharmax_app, pharmax_system;

-- RLS: standard tenant-isolation policy.
ALTER TABLE "compounding_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compounding_record" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "compounding_record"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

ALTER TABLE "compounding_record_ingredient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compounding_record_ingredient" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "compounding_record_ingredient"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "compounding_record" IS
  'USP <795>/<797> Compounding Record (ADR-0035 slice 2): per-preparation FILL-stage artifact pinning the formula version, computed BUD, USP <800> handling documentation, QC outcome, and the rendered record document (in-row, RLS-protected — contains order/rx identifiers). Append-only; written only by RecordCompoundingPreparation.';
COMMENT ON TABLE "compounding_record_ingredient" IS
  'Consumed component of a compounding record. Product-backed components reference the consumed Lot (paired with a COMPOUND_CONSUMED inventory transaction); bulk chemicals record a manual lot number per USP component-documentation requirements.';
