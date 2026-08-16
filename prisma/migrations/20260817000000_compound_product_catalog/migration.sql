-- Compound product catalog identity (Products/Compounds tab, PR 1).
--
-- Two additions:
--
--   1. Compound identity columns on `product`. An in-house compound
--      gets a minted, human-readable Pharmax Product ID ("PXP-000042")
--      plus the serial-identity fields that later stamp every batch
--      unit number (the "T30" in PHX-T30-1-040327-11: first letter of
--      the primary drug + total mg of that drug in one container).
--      All nullable — NATIONAL products are identified by their real
--      NDC and never carry these.
--
--   2. The `pharmax_product_id_sequence` allocator, one counter row
--      per organization. The Pharmax Product ID is printed on batch
--      labels and quoted by the testing lab, so — like the Rx number
--      (see 20260806000000_rx_number_sequence) — it must be dense,
--      monotonic, and never operator-typed. It cannot be
--      `MAX(pharmaxProductId) + 1`: two concurrent creations would
--      read the same maximum and collide. The allocator row is
--      incremented inside the CreateCompoundProduct transaction; the
--      row lock serializes concurrent creations for one org. A
--      rolled-back transaction consumes its number — a gap in the
--      series is explainable, a reused catalog id is not.

-- Counting unit for compounded batches ("how many VIALS in this
-- batch"). A counting unit, not a dosage form — that nuance stays in
-- the free-text `form` column.
CREATE TYPE "ProductUnitKind" AS ENUM
    ('VIAL', 'TABLET', 'CAPSULE', 'SYRINGE', 'PEN', 'TROCHE', 'OTHER');

-- Additive columns on the existing RLS-scoped "product" table — no
-- new RLS policy needed for these.
ALTER TABLE "product"
    ADD COLUMN "pharmaxProductId"  TEXT,
    ADD COLUMN "serialDrugInitial" TEXT,
    ADD COLUMN "serialDrugMg"      INTEGER,
    ADD COLUMN "unitKind"          "ProductUnitKind";

-- One catalog id per org. NULLs (NATIONAL products) do not collide
-- under Postgres unique-index semantics, so only minted ids are
-- constrained.
CREATE UNIQUE INDEX "product_organizationId_pharmaxProductId_key"
    ON "product"("organizationId", "pharmaxProductId");

-- The serial identity must be internally consistent when present: a
-- single uppercase letter and a positive mg amount. The command layer
-- validates first; these CHECKs catch a hand-edit in psql that would
-- otherwise print garbage on every batch label of the product.
ALTER TABLE "product"
    ADD CONSTRAINT "product_serialDrugInitial_shape"
    CHECK ("serialDrugInitial" IS NULL OR "serialDrugInitial" ~ '^[A-Z]$');

ALTER TABLE "product"
    ADD CONSTRAINT "product_serialDrugMg_positive"
    CHECK ("serialDrugMg" IS NULL OR "serialDrugMg" > 0);

-- ---------------------------------------------------------------------
-- Allocator table
-- ---------------------------------------------------------------------

CREATE TABLE "pharmax_product_id_sequence" (
    "organizationId" UUID NOT NULL,

    -- Last value HANDED OUT, not the next one to hand out. Starts at
    -- 0, so the first allocation returns 1 and the column always
    -- answers "how many compound products has this org ever minted"
    -- without an off-by-one.
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmax_product_id_sequence_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "pharmax_product_id_sequence"
    ADD CONSTRAINT "pharmax_product_id_sequence_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The counter must never run backwards, including via a buggy future
-- migration or a hand-edit in psql. A CHECK cannot express "never
-- decreases", but it can express "never negative", which catches the
-- overflow-wraparound and the accidental `SET lastValue = -1` reset.
ALTER TABLE "pharmax_product_id_sequence"
    ADD CONSTRAINT "pharmax_product_id_sequence_lastValue_nonneg"
    CHECK ("lastValue" >= 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pharmax_product_id_sequence"
    TO pharmax_app, pharmax_system;

ALTER TABLE "pharmax_product_id_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmax_product_id_sequence" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "pharmax_product_id_sequence"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "pharmax_product_id_sequence" IS
  'Per-organization Pharmax Product ID allocator. Incremented inside the CreateCompoundProduct transaction; the row lock serializes concurrent compound creations for one org so the PXP series stays dense and monotonic. Rolled-back transactions consume their number — gaps are acceptable, reuse is not.';
