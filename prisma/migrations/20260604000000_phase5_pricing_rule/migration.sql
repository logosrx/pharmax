-- migration: 20260604000000_phase5_pricing_rule
--
-- Per-tenant pricing rules for outbound billing. Rules are resolved
-- by specificity at materialization time:
--
--   (clinicId + productId)  → most specific
--   (clinicId, no product)
--   (no clinic, productId)
--   (no clinic, no product)  → org-wide default
--
-- Each scope (organization, clinic, product, kind) holds AT MOST
-- ONE active rule at a time. The `UpsertPricingRule` command
-- transactionally supersedes the prior ACTIVE rule by setting its
-- `effectiveTo` to the new rule's `effectiveFrom`; the resolver
-- therefore picks the unique current rule for any scope/timestamp.
--
-- A rule's `pricingScheme` stamp is propagated onto invoice lines
-- so a future re-pricing can backfill historical lines and
-- discriminate FLAT_V1 placeholders from RULE_V2 (or later)
-- rule-derived prices.
--
-- PHI invariant: no PHI columns. Pricing is non-PHI by definition.

CREATE TYPE "PricingRuleStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'ARCHIVED');

CREATE TABLE "pricing_rule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    -- NULL ⇒ rule applies to all clinics in the org.
    "clinicId" UUID,
    -- NULL ⇒ rule applies to all products. The current materialize
    -- handler emits ONE dispense fee per shipped order without a
    -- productId; product-level pricing is wired structurally so
    -- a future per-line pricing flow can adopt it without a
    -- schema change.
    "productId" UUID,
    -- Matches `InvoiceLineKind` from the schema. The materialize
    -- handler currently only writes DISPENSE_FEE; SHIPPING_FEE +
    -- RUSH_FEE land in follow-up slices.
    "kind" "InvoiceLineKind" NOT NULL,
    "unitAmountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    -- Inclusive lower bound. Resolver picks the rule whose window
    -- contains `occurredAt`. effectiveFrom defaults to the row
    -- creation time so callers can omit it for "starts now" rules.
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Exclusive upper bound. NULL ⇒ open-ended (current rule).
    -- Set by UpsertPricingRule when a successor is added for the
    -- same scope.
    "effectiveTo" TIMESTAMP(3),
    "status" "PricingRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    -- Operator note (NOT PHI). Free-text reason for the rule:
    -- "Q3 2026 contract renegotiation", "Promo for clinic X", etc.
    "notes" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createCommandLogId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pricing_rule_pkey" PRIMARY KEY ("id")
);

-- At most one ACTIVE rule per (organizationId, clinicId, productId, kind).
-- Use COALESCE to treat NULL clinicId / productId as distinct
-- partial-key values rather than "not equal to anything".
CREATE UNIQUE INDEX "pricing_rule_active_unique"
    ON "pricing_rule"(
        "organizationId",
        COALESCE("clinicId", '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE("productId", '00000000-0000-0000-0000-000000000000'::uuid),
        "kind"
    )
    WHERE "status" = 'ACTIVE';

-- Resolver lookup path: filter by (org, kind, status, time window)
-- then order by (clinic-present, product-present, effectiveFrom).
CREATE INDEX "pricing_rule_resolver_idx"
    ON "pricing_rule"("organizationId", "kind", "status", "effectiveFrom" DESC);

-- Operator dashboards: list all rules for a clinic.
CREATE INDEX "pricing_rule_clinic_idx"
    ON "pricing_rule"("organizationId", "clinicId");

ALTER TABLE "pricing_rule" ADD CONSTRAINT "pricing_rule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_rule" ADD CONSTRAINT "pricing_rule_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_rule" ADD CONSTRAINT "pricing_rule_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_rule" ADD CONSTRAINT "pricing_rule_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_rule" ADD CONSTRAINT "pricing_rule_createCommandLogId_fkey"
    FOREIGN KEY ("createCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['pricing_rule']
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
