-- Compound-preparation allergy screening (ADR-0035 follow-on; PR #87/#88 arc).
--
-- Three changes, all columns on existing tenant-scoped tables (RLS is
-- already enabled and FORCEd on every table touched — column additions
-- inherit the tenant-isolation policies, and no policy changes are
-- needed or made here):
--
--   1. `compound_formula.compoundProductId` — the PV1-time link. A
--      compound product IS a recipe with an identity; the formula
--      declares which catalog product it is the recipe FOR, so a
--      prescription (which carries only the product's org-local NDC)
--      resolves to a screenable ingredient list BEFORE fill time. On
--      the formula rather than on `product` because the formula's
--      draft→publish cycle is already commanded, permission-gated,
--      audited and append-only versioned, while `product` has no
--      application write path at all — and the link is
--      screening-relevant, so changing it MUST be a versioned,
--      attributable act.
--
--   2. `compound_formula_ingredient.coding` + `rxnormInRxcui` — the
--      per-row machine-readable identity (RxNorm ingredient IN RXCUI,
--      the code space `patient_allergy` RXNORM rows use), or the
--      recorded assertion that none applies (a base/excipient). The
--      CHECK ties the two in both directions so a row cannot claim to
--      be coded without a code, or carry a code it disclaims.
--
--   3. `order_screening_finding.formulaId/formulaCode/formulaVersion`
--      — formula-release attribution, the same treatment
--      `knowledgeSourceCode`/`knowledgeReleaseVersion` give the RxNorm
--      release: recipes are republished, and "which recipe did March's
--      screen read?" must survive that. Code + version denormalized
--      beside the id, as `compounding_record` does.
--
-- No PHI in any column added here: formula links, enum states, RxNorm
-- concept identifiers and formula version numbers only.

-- ---------------------------------------------------------------------
-- 1. The PV1-time product → formula link
-- ---------------------------------------------------------------------

ALTER TABLE "compound_formula"
    ADD COLUMN "compoundProductId" UUID;

ALTER TABLE "compound_formula"
    ADD CONSTRAINT "compound_formula_compoundProductId_fkey"
    FOREIGN KEY ("compoundProductId") REFERENCES "product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The screen's lookup: "the ACTIVE formula claiming this product".
CREATE INDEX "compound_formula_organizationId_compoundProductId_status_idx"
    ON "compound_formula"("organizationId", "compoundProductId", "status");

-- At most one ACTIVE formula may claim a product. Two recipes both
-- claiming to be "the" recipe for one dispensable product would make
-- the screen's answer depend on which row a query returned first —
-- this serializes the conflict at publish time instead.
CREATE UNIQUE INDEX "compound_formula_active_product_unique"
    ON "compound_formula"("organizationId", "compoundProductId")
    WHERE "status" = 'ACTIVE' AND "compoundProductId" IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Per-row ingredient coding
-- ---------------------------------------------------------------------

CREATE TYPE "CompoundIngredientCoding" AS ENUM (
    'UNCODED',
    'RXNORM_IN',
    'NO_RXNORM_INGREDIENT'
);

ALTER TABLE "compound_formula_ingredient"
    ADD COLUMN "coding" "CompoundIngredientCoding" NOT NULL DEFAULT 'UNCODED',
    ADD COLUMN "rxnormInRxcui" TEXT;

-- Coded ⇔ carries a code, in both directions. A row that says
-- RXNORM_IN with no code would read as machine-screened while
-- contributing nothing to the screen; a row carrying a code it
-- disclaims would be a statement nobody made.
ALTER TABLE "compound_formula_ingredient"
    ADD CONSTRAINT "compound_formula_ingredient_coding_rxcui_check"
    CHECK (("coding" = 'RXNORM_IN') = ("rxnormInRxcui" IS NOT NULL));

-- ---------------------------------------------------------------------
-- 3. Formula attribution on persisted findings
-- ---------------------------------------------------------------------

ALTER TABLE "order_screening_finding"
    ADD COLUMN "formulaId" UUID,
    ADD COLUMN "formulaCode" TEXT,
    ADD COLUMN "formulaVersion" INTEGER;

ALTER TABLE "order_screening_finding"
    ADD CONSTRAINT "order_screening_finding_formulaId_fkey"
    FOREIGN KEY ("formulaId") REFERENCES "compound_formula"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The three stamp columns travel together: an id without the
-- denormalized (code, version) would stop the row being
-- self-describing, and a (code, version) without the id would break
-- the join back to the recipe.
ALTER TABLE "order_screening_finding"
    ADD CONSTRAINT "order_screening_finding_formula_stamp_check"
    CHECK (
        ("formulaId" IS NULL AND "formulaCode" IS NULL AND "formulaVersion" IS NULL)
        OR ("formulaId" IS NOT NULL AND "formulaCode" IS NOT NULL AND "formulaVersion" IS NOT NULL)
    );

COMMENT ON COLUMN "compound_formula"."compoundProductId" IS
  'The catalog product this formula is the recipe for — the PV1-time link from a prescription''s NDC to a screenable ingredient list. At most one ACTIVE formula per product (partial unique). Changing the link means publishing a new version.';
COMMENT ON COLUMN "compound_formula_ingredient"."coding" IS
  'Per-row machine-readability statement: UNCODED (nobody has said), RXNORM_IN (rxnormInRxcui names the RxNorm ingredient concept), NO_RXNORM_INGREDIENT (asserted base/excipient with no RxNorm concept). CHECK ties RXNORM_IN to the code column in both directions.';
COMMENT ON COLUMN "order_screening_finding"."formulaId" IS
  'The compound formula version this finding was screened against, when the finding involved a compound product''s declared ingredients. NULL on findings that involved no formula. Code and version are denormalized beside it, as on compounding_record.';
