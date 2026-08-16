-- AI typing-assist guardrails (phase 1 of the typing-assist plan).
--
-- Two tenant-scoped configuration tables:
--
--   1. product_ai_guardrail — the pharmacy's own statement of what a
--      plausible fill of one catalog product looks like (quantity /
--      days-supply / refills ceilings, per-product AI kill switch).
--      Consumed by the deterministic typing validators today and by
--      the model-suggestion pipeline later: a model suggestion that
--      violates the guardrail is discarded before a human sees it.
--
--   2. ai_assist_policy — the org-level master switch and thresholds
--      for model-backed typing suggestions. One row per organization.
--      Typing assist is OFF by default; an org that never writes this
--      table gets deterministic validation only and no model ever
--      runs against its data.
--
-- Both tables version-bump on every change so downstream suggestion
-- records can pin the exact revision that governed them (the
-- workflow_policy_id/version pinning pattern).
--
-- No PHI in either table: product-level and org-level configuration
-- only.

-- ---------------------------------------------------------------------
-- 1. product_ai_guardrail
-- ---------------------------------------------------------------------

CREATE TABLE "product_ai_guardrail" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,

    "aiSuggestionsEnabled" BOOLEAN NOT NULL DEFAULT true,

    "maxQuantityPerFill" DECIMAL(18,4),
    "maxDaysSupplyPerFill" INTEGER,
    "maxRefillsAuthorized" INTEGER,

    "version" INTEGER NOT NULL DEFAULT 1,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_ai_guardrail_pkey" PRIMARY KEY ("id")
);

-- Ceilings must be positive when present: a zero or negative ceiling
-- would reject every fill of the product, which is a configuration
-- error the database should refuse rather than store.
ALTER TABLE "product_ai_guardrail"
    ADD CONSTRAINT "product_ai_guardrail_max_quantity_positive"
    CHECK ("maxQuantityPerFill" IS NULL OR "maxQuantityPerFill" > 0);
ALTER TABLE "product_ai_guardrail"
    ADD CONSTRAINT "product_ai_guardrail_max_days_supply_positive"
    CHECK ("maxDaysSupplyPerFill" IS NULL OR "maxDaysSupplyPerFill" > 0);
ALTER TABLE "product_ai_guardrail"
    ADD CONSTRAINT "product_ai_guardrail_max_refills_nonnegative"
    CHECK ("maxRefillsAuthorized" IS NULL OR "maxRefillsAuthorized" >= 0);

CREATE UNIQUE INDEX "product_ai_guardrail_productId_key"
    ON "product_ai_guardrail"("productId");
CREATE UNIQUE INDEX "product_ai_guardrail_organizationId_productId_key"
    ON "product_ai_guardrail"("organizationId", "productId");

ALTER TABLE "product_ai_guardrail" ADD CONSTRAINT "product_ai_guardrail_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_ai_guardrail" ADD CONSTRAINT "product_ai_guardrail_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 2. ai_assist_policy
-- ---------------------------------------------------------------------

CREATE TABLE "ai_assist_policy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "typingAssistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minConfidencePercent" INTEGER NOT NULL DEFAULT 90,
    "allowControlledSubstanceSuggestions" BOOLEAN NOT NULL DEFAULT false,

    "version" INTEGER NOT NULL DEFAULT 1,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_assist_policy_pkey" PRIMARY KEY ("id")
);

-- Confidence is a percentage. The command validates this too; the
-- CHECK is the layer a handler bug cannot reach around.
ALTER TABLE "ai_assist_policy"
    ADD CONSTRAINT "ai_assist_policy_confidence_percent_range"
    CHECK ("minConfidencePercent" >= 0 AND "minConfidencePercent" <= 100);

CREATE UNIQUE INDEX "ai_assist_policy_organizationId_key"
    ON "ai_assist_policy"("organizationId");

ALTER TABLE "ai_assist_policy" ADD CONSTRAINT "ai_assist_policy_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 3. Grants. SELECT + INSERT + UPDATE: both tables are upserted
--    configuration with a version bump on change. DELETE is granted
--    to neither role — removing a guardrail is an UPDATE that clears
--    the ceilings (audited through the command), never a row that
--    silently disappears from the history an auditor walks.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "product_ai_guardrail" TO pharmax_app, pharmax_system;
REVOKE DELETE ON TABLE "product_ai_guardrail" FROM pharmax_app, pharmax_system;

GRANT SELECT, INSERT, UPDATE ON TABLE "ai_assist_policy" TO pharmax_app, pharmax_system;
REVOKE DELETE ON TABLE "ai_assist_policy" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 4. Row-level security: enabled AND forced, split per-command
--    policies — same posture as every tenant-scoped table.
-- ---------------------------------------------------------------------

ALTER TABLE "product_ai_guardrail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_ai_guardrail" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "product_ai_guardrail"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "product_ai_guardrail"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_update ON "product_ai_guardrail"
  FOR UPDATE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

ALTER TABLE "ai_assist_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_assist_policy" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "ai_assist_policy"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "ai_assist_policy"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_update ON "ai_assist_policy"
  FOR UPDATE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 5. Table comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "product_ai_guardrail" IS
  'Tenant-authored safety envelope for the AI typing assistant, 1:1 with a catalog product. Ceilings (quantity per fill, days supply, refills) drive the deterministic typing validators today and bound model suggestions later; aiSuggestionsEnabled=false removes the product from the model-suggestion surface without disabling deterministic validation. Version bumps on every SetProductAiGuardrail so suggestion records can pin the revision they were screened against. No PHI — product-level configuration only. No DELETE grant: clearing a guardrail is an audited UPDATE, never a vanished row.';

COMMENT ON TABLE "ai_assist_policy" IS
  'Org-level master switch and thresholds for model-backed typing suggestions (one row per organization, upserted by SetAiAssistPolicy). Typing assist is OFF by default — an org that never writes this table gets deterministic validation only and no model ever runs against its data. minConfidencePercent gates what a technician is shown; allowControlledSubstanceSuggestions defaults to false because the cost of a wrong suggestion is highest where regulation is tightest. Version bumps on every change for revision pinning. No PHI.';
