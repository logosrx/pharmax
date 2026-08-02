-- Compounding domain, slice 1 (ADR-0035).
--
-- Adds:
--   * `compound_formula` — the versioned Master Formulation Record
--     (USP <795>/<797>): recipe identity, BUD policy, hazard flag,
--     lifecycle DRAFT → ACTIVE → RETIRED. Immutable once ACTIVE.
--   * `compound_formula_ingredient` — queryable ingredient child rows
--     with an optional FK into the product catalog (recall lookups).
--   * Partial UNIQUE enforcing at most one DRAFT per
--     (organization, code) so concurrent draft creation serializes.
--
-- No PHI in either table: formulas are recipes, ingredients are
-- drugs/chemicals.

-- Enums.
CREATE TYPE "CompoundFormulaStatus" AS ENUM (
    'DRAFT',
    'ACTIVE',
    'RETIRED'
);

CREATE TYPE "CompoundPreparationKind" AS ENUM (
    'NONSTERILE',
    'STERILE'
);

CREATE TYPE "CompoundBudBasis" AS ENUM (
    'USP795_NONAQUEOUS',
    'USP795_AQUEOUS_PRESERVED',
    'USP795_AQUEOUS_NONPRESERVED',
    'USP797_CATEGORY_1',
    'USP797_CATEGORY_2',
    'USP797_CATEGORY_3',
    'STABILITY_STUDY'
);

CREATE TYPE "CompoundStorageCondition" AS ENUM (
    'ROOM_TEMPERATURE',
    'REFRIGERATED',
    'FROZEN'
);

CREATE TYPE "CompoundFormulaRetireReason" AS ENUM (
    'SAFETY',
    'FORMULARY_CHANGE',
    'INGREDIENT_SOURCING',
    'REGULATORY',
    'ERROR'
);

-- Master Formulation Record.
CREATE TABLE "compound_formula" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CompoundFormulaStatus" NOT NULL DEFAULT 'DRAFT',

    "name" TEXT NOT NULL,
    "description" TEXT,

    "preparationKind" "CompoundPreparationKind" NOT NULL,
    "hazardous" BOOLEAN NOT NULL DEFAULT false,

    "finalForm" TEXT,
    "finalStrength" TEXT,

    "budDays" INTEGER NOT NULL,
    "budBasis" "CompoundBudBasis" NOT NULL,
    "budReference" TEXT,
    "storageCondition" "CompoundStorageCondition" NOT NULL,

    "instructions" TEXT NOT NULL,
    "qualityChecks" TEXT,

    "createdByUserId" UUID NOT NULL,

    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "retiredReason" "CompoundFormulaRetireReason",

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compound_formula_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "compound_formula"
    ADD CONSTRAINT "compound_formula_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_formula"
    ADD CONSTRAINT "compound_formula_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "compound_formula_organizationId_code_version_key"
    ON "compound_formula"("organizationId", "code", "version");
CREATE INDEX "compound_formula_organizationId_status_code_idx"
    ON "compound_formula"("organizationId", "status", "code");

-- At most one DRAFT per (organization, code). Prisma cannot express
-- partial indexes; documented on the model.
CREATE UNIQUE INDEX "compound_formula_draft_unique"
    ON "compound_formula"("organizationId", "code")
    WHERE "status" = 'DRAFT';

-- Ingredient lines.
CREATE TABLE "compound_formula_ingredient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "formulaId" UUID NOT NULL,
    "productId" UUID,

    "ingredientName" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compound_formula_ingredient_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "compound_formula_ingredient"
    ADD CONSTRAINT "compound_formula_ingredient_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_formula_ingredient"
    ADD CONSTRAINT "compound_formula_ingredient_formulaId_fkey"
    FOREIGN KEY ("formulaId") REFERENCES "compound_formula"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compound_formula_ingredient"
    ADD CONSTRAINT "compound_formula_ingredient_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "compound_formula_ingredient_formulaId_idx"
    ON "compound_formula_ingredient"("formulaId");
CREATE INDEX "compound_formula_ingredient_organizationId_productId_idx"
    ON "compound_formula_ingredient"("organizationId", "productId");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "compound_formula"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "compound_formula_ingredient"
    TO pharmax_app, pharmax_system;

-- RLS: standard tenant-isolation policy.
ALTER TABLE "compound_formula" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compound_formula" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "compound_formula"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

ALTER TABLE "compound_formula_ingredient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compound_formula_ingredient" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "compound_formula_ingredient"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "compound_formula" IS
  'Master Formulation Record (USP <795>/<797>, ADR-0035): versioned compounding recipe with BUD policy and USP <800> hazard flag. Lifecycle DRAFT -> ACTIVE -> RETIRED through commands only; ACTIVE versions are immutable and publishing retires the predecessor. No PHI.';
COMMENT ON TABLE "compound_formula_ingredient" IS
  'Ingredient line of a Master Formulation Record. Optional FK to the product catalog enables recall lookups (which formulas use this product). No PHI.';
