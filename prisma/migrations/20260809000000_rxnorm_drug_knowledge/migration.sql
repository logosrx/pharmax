-- RxNorm drug-knowledge reference tables, product NDC-kind flag, and
-- knowledge-release attribution on screening findings.
--
-- This is the platform's first GLOBAL reference data: drug
-- nomenclature is not tenant data, so these tables carry no
-- organizationId and no tenant RLS policy. They are listed in
-- prisma/migrations/rls-exempt.txt and classified in
-- TENANT_EXCLUDED_MODELS with the same rationale as `permission`:
-- the same rows are visible to every organization by design, and the
-- rows contain nothing tenant-derived — no PHI, no org identifiers,
-- only public NLM nomenclature (NDC → RXCUI → ingredient).
--
-- Source: RxNorm "Current Prescribable Content" (NLM), a public
-- artifact free of UMLS source-vocabulary license restrictions. See
-- docs/governance/public-sources-reference.md §4. Nomenclature only:
-- no interaction facts, cross-sensitivity groupings, dose ranges or
-- severity gradings may ever be loaded here (clean-room policy).
--
-- Write path: the ingestion job only
-- (scripts/operations/ingest-rxnorm-release.ts), running with a role
-- that holds the write grants below. The application role reads.

-- ---------------------------------------------------------------------
-- 1. Release lifecycle.
--
--    Real Postgres enum (like the Allergy* vocabulary, unlike
--    screening finding codes): the lifecycle is structurally closed —
--    a fifth state is a design change to the atomic-swap protocol,
--    which SHOULD require a reviewed migration.
-- ---------------------------------------------------------------------

CREATE TYPE "RxnormReleaseStatus" AS ENUM (
    'STAGED',
    'LIVE',
    'SUPERSEDED',
    'FAILED'
);

CREATE TABLE "rxnorm_release" (
    "id" UUID NOT NULL,

    "version" TEXT NOT NULL,
    "releasedOn" DATE NOT NULL,
    "checksumSha256" TEXT NOT NULL,

    "status" "RxnormReleaseStatus" NOT NULL DEFAULT 'STAGED',

    "ndcCount" INTEGER NOT NULL DEFAULT 0,
    "ingredientLinkCount" INTEGER NOT NULL DEFAULT 0,

    "loadedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "failedReason" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rxnorm_release_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rxnorm_release_checksumSha256_key"
    ON "rxnorm_release"("checksumSha256");
CREATE INDEX "rxnorm_release_status_idx"
    ON "rxnorm_release"("status");

-- At most ONE live release, enforced at the database layer rather
-- than by the ingestion job's good behaviour. Readers resolve "the
-- live release" with a findFirst; two LIVE rows would make that
-- lookup nondeterministic — a screen could grade the same order
-- against two different bodies of knowledge depending on plan choice.
-- Prisma cannot express partial indexes; documented on the model.
CREATE UNIQUE INDEX "rxnorm_release_one_live"
    ON "rxnorm_release"("status")
    WHERE "status" = 'LIVE';

-- ---------------------------------------------------------------------
-- 2. Data rows. Composite PKs keyed by release id first, so every
--    reader query is anchored on the release resolved inside its own
--    transaction — the mechanism that makes a half-loaded release
--    unobservable.
--
--    ON DELETE CASCADE from the release is deliberate (junction
--    semantics): pruning a SUPERSEDED or FAILED release removes its
--    rows in one statement. The finding attribution stamped on
--    `order_screening_finding` survives pruning because it copies the
--    version STRING rather than referencing the release row.
-- ---------------------------------------------------------------------

CREATE TABLE "rxnorm_ndc_product" (
    "releaseId" UUID NOT NULL,
    "ndc11" TEXT NOT NULL,
    "productRxcui" TEXT NOT NULL,

    CONSTRAINT "rxnorm_ndc_product_pkey" PRIMARY KEY ("releaseId", "ndc11")
);

ALTER TABLE "rxnorm_ndc_product"
    ADD CONSTRAINT "rxnorm_ndc_product_releaseId_fkey"
    FOREIGN KEY ("releaseId") REFERENCES "rxnorm_release"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "rxnorm_ndc_product_releaseId_productRxcui_idx"
    ON "rxnorm_ndc_product"("releaseId", "productRxcui");

CREATE TABLE "rxnorm_product_ingredient" (
    "releaseId" UUID NOT NULL,
    "productRxcui" TEXT NOT NULL,
    "ingredientRxcui" TEXT NOT NULL,
    "ingredientTty" TEXT NOT NULL,
    "ingredientName" TEXT NOT NULL,

    CONSTRAINT "rxnorm_product_ingredient_pkey"
        PRIMARY KEY ("releaseId", "productRxcui", "ingredientRxcui")
);

ALTER TABLE "rxnorm_product_ingredient"
    ADD CONSTRAINT "rxnorm_product_ingredient_releaseId_fkey"
    FOREIGN KEY ("releaseId") REFERENCES "rxnorm_release"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 3. Grants. App code reads; only the ingestion job writes.
--
--    `pharmax_app` gets SELECT only — a compromised application
--    session must not be able to rewrite the reference data every
--    tenant screens against (poisoning an ingredient list is a
--    patient-safety attack, not a data-integrity nuisance).
--    `pharmax_system` gets the write set the ingestion job needs
--    (INSERT to stage, UPDATE to swap statuses, DELETE to clean up a
--    failed or pruned release).
-- ---------------------------------------------------------------------

GRANT SELECT ON TABLE "rxnorm_release", "rxnorm_ndc_product", "rxnorm_product_ingredient"
    TO pharmax_app;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE "rxnorm_release", "rxnorm_ndc_product", "rxnorm_product_ingredient"
    TO pharmax_system;
REVOKE INSERT, UPDATE, DELETE
    ON TABLE "rxnorm_release", "rxnorm_ndc_product", "rxnorm_product_ingredient"
    FROM pharmax_app;

-- ---------------------------------------------------------------------
-- 4. Product NDC-kind flag.
--
--    Compounded preparations carry org-local identifiers in the `ndc`
--    column; national nomenclature has never heard of them. The
--    screening layer grades its knowledge gaps on this flag so a
--    compound does not demand a "verify the NDC" acknowledgement on
--    every order forever. Default NATIONAL: the conservative
--    direction (over-prompting) for pre-existing rows.
-- ---------------------------------------------------------------------

CREATE TYPE "ProductNdcKind" AS ENUM (
    'NATIONAL',
    'IN_HOUSE_COMPOUND'
);

ALTER TABLE "product"
    ADD COLUMN "ndcKind" "ProductNdcKind" NOT NULL DEFAULT 'NATIONAL';

-- ---------------------------------------------------------------------
-- 5. Knowledge-release attribution on screening findings — the same
--    treatment workflowPolicyId/Version already give the policy.
--    Nullable: rows written before a knowledge source existed, or
--    against a source with no release identity (the empty in-memory
--    source), honestly carry NULL.
-- ---------------------------------------------------------------------

ALTER TABLE "order_screening_finding"
    ADD COLUMN "knowledgeSourceCode" TEXT,
    ADD COLUMN "knowledgeReleaseVersion" TEXT;

-- ---------------------------------------------------------------------
-- 6. Table documentation.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "rxnorm_release" IS
  'One loaded (or loading, or retired) RxNorm Current Prescribable Content release. Global reference data — deliberately not tenant-scoped (see rls-exempt.txt). At most one LIVE row, enforced by a partial unique index; ingestion stages rows under STAGED and promotes atomically, so screening never observes a half-loaded release.';

COMMENT ON TABLE "rxnorm_ndc_product" IS
  'NDC (normalized 11-digit) to RxNorm product concept (RXCUI), per release. Public NLM nomenclature; no PHI, no tenant data.';

COMMENT ON TABLE "rxnorm_product_ingredient" IS
  'RxNorm product concept (RXCUI) to active ingredient (IN/PIN RXCUI), per release. Public NLM nomenclature; no PHI, no tenant data. Contains NO interaction, cross-sensitivity or dose-range content — those are licensed editorial works excluded by the clean-room policy.';
