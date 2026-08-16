-- Compound batch lifecycle (Products/Compounds, PR 2).
--
-- Two tables:
--
--   1. `compound_batch` — one production run of an in-house compound
--      at a site, carrying the human/scannable batch number
--      ("PHX-T30-1-081626"), the Beyond-Use Date, and the quality
--      lifecycle COMPOUNDED → TESTING → RELEASED ⇄ DISPENSING with
--      REJECTED as the terminal lab-failure exit.
--
--   2. `compound_batch_unit` — one row per physical unit (vial,
--      tablet, …) minted WITH the batch, each holding the serial
--      number printed on its label ("<batchNumber>-<unitNumber>").
--      Serials are born with the batch: a vial that exists without a
--      serial is untraceable by definition.

CREATE TYPE "CompoundBatchStatus" AS ENUM
    ('COMPOUNDED', 'TESTING', 'RELEASED', 'DISPENSING', 'REJECTED');

-- ---------------------------------------------------------------------
-- compound_batch
-- ---------------------------------------------------------------------

CREATE TABLE "compound_batch" (
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId"         UUID NOT NULL,
    "productId"      UUID NOT NULL,

    "batchNumber"  TEXT NOT NULL,
    "daySequence"  INTEGER NOT NULL,
    "compoundedOn" DATE NOT NULL,

    -- Beyond-Use Date (USP <797>). Dispensing past this date is
    -- blocked downstream regardless of status.
    "beyondUseDate" DATE NOT NULL,

    "status"          "CompoundBatchStatus" NOT NULL DEFAULT 'COMPOUNDED',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "rejectionReasonCode" TEXT,

    "unitCount"    INTEGER NOT NULL,
    "barcodeValue" TEXT NOT NULL,

    "createdByUserId" UUID NOT NULL,
    "commandLogId"    UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compound_batch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "compound_batch_organizationId_batchNumber_key"
    ON "compound_batch"("organizationId", "batchNumber");

CREATE UNIQUE INDEX "compound_batch_organizationId_barcodeValue_key"
    ON "compound_batch"("organizationId", "barcodeValue");

-- Serializes the batch-of-the-day counter: CreateCompoundBatch
-- allocates daySequence as COUNT+1; two concurrent creations for the
-- same (site, product, day) collide here and one retries, instead of
-- two batches sharing a serial prefix.
--
-- Short explicit name: the conventional
-- "<table>_<col>_<col>…_key" form is 75 characters, past Postgres's
-- 63-character identifier limit, so the server would silently
-- truncate it and permanently diverge from schema.prisma. The
-- matching `map:` is on the @@unique there.
CREATE UNIQUE INDEX "compound_batch_day_sequence_key"
    ON "compound_batch"("organizationId", "siteId", "productId", "compoundedOn", "daySequence");

CREATE INDEX "compound_batch_organizationId_siteId_status_idx"
    ON "compound_batch"("organizationId", "siteId", "status");

CREATE INDEX "compound_batch_organizationId_productId_status_idx"
    ON "compound_batch"("organizationId", "productId", "status");

-- At most ONE batch of a product may be the dispensing batch at a
-- site. StartDispensingCompoundBatch demotes the incumbent in the
-- same transaction; this partial unique index is the backstop that
-- makes a race produce an error instead of two "current" batches.
-- (Partial indexes are not expressible in schema.prisma — this is an
-- accepted entry in prisma/migrations/drift-baseline.txt.)
CREATE UNIQUE INDEX "compound_batch_single_dispensing_per_product_site"
    ON "compound_batch"("organizationId", "siteId", "productId")
    WHERE "status" = 'DISPENSING';

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_unitCount_positive"
    CHECK ("unitCount" > 0);

ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_daySequence_positive"
    CHECK ("daySequence" > 0);

-- A BUD on or before the compounding date would create a batch that
-- is expired at birth.
ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_bud_after_compounding"
    CHECK ("beyondUseDate" > "compoundedOn");

-- "Every rejection requires a reason code" — and a reason on a
-- non-rejected batch is a state bug, so the implication runs both
-- ways.
ALTER TABLE "compound_batch"
    ADD CONSTRAINT "compound_batch_rejection_reason_iff_rejected"
    CHECK (("status" = 'REJECTED') = ("rejectionReasonCode" IS NOT NULL));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "compound_batch"
    TO pharmax_app, pharmax_system;

ALTER TABLE "compound_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compound_batch" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "compound_batch"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "compound_batch" IS
  'One production run of an in-house compound at a pharmacy site. Lifecycle: COMPOUNDED → TESTING → RELEASED ⇄ DISPENSING, REJECTED terminal. Batch number embeds site code, product serial identity, batch-of-day counter, and compounding date; every unit serial appends its unit number.';

-- ---------------------------------------------------------------------
-- compound_batch_unit
-- ---------------------------------------------------------------------

CREATE TABLE "compound_batch_unit" (
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "batchId"        UUID NOT NULL,

    "unitNumber"   INTEGER NOT NULL,
    "serialNumber" TEXT NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compound_batch_unit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "compound_batch_unit"
    ADD CONSTRAINT "compound_batch_unit_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_batch_unit"
    ADD CONSTRAINT "compound_batch_unit_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "compound_batch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "compound_batch_unit_batchId_unitNumber_key"
    ON "compound_batch_unit"("batchId", "unitNumber");

-- One serial resolves to one unit, org-wide — the whole point of
-- scanning it.
CREATE UNIQUE INDEX "compound_batch_unit_organizationId_serialNumber_key"
    ON "compound_batch_unit"("organizationId", "serialNumber");

ALTER TABLE "compound_batch_unit"
    ADD CONSTRAINT "compound_batch_unit_unitNumber_positive"
    CHECK ("unitNumber" > 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "compound_batch_unit"
    TO pharmax_app, pharmax_system;

ALTER TABLE "compound_batch_unit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compound_batch_unit" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "compound_batch_unit"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "compound_batch_unit" IS
  'One physical unit (vial/tablet/…) of a compound batch, minted with the batch and carrying the serial number printed on its label: <batchNumber>-<unitNumber>. Immutable identity record — dispense/waste state attaches in the scan-traceability slice.';
