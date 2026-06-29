-- Add the missing NULLIF('') guard to the three Phase-5 policies.
--
-- Second half of the policy repair started by
-- 20260629000000_fix_system_context_sentinel. The three Phase-5
-- policies (notification_delivery, access_review_snapshot,
-- report_run) deviated from the RLS baseline's canonical predicate in
-- TWO ways:
--
--   1. sentinel: compared pharmax.system_context to 'true' instead of
--      'on'                                  (fixed by 20260629000000)
--   2. missing NULLIF: cast the org GUC straight to uuid —
--        "organizationId" = current_setting('pharmax.organization_id', true)::uuid
--      instead of the baseline's
--        "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
--                                                  (fixed HERE)
--
-- Why (2) matters: `applySystemSessionGuc` clears the org GUC to ''
-- (empty string) when entering system context, and Postgres does NOT
-- short-circuit OR in policy predicates — so ''::uuid raises
--   invalid input syntax for type uuid: ""
-- and EVERY query against these tables errors whenever the org GUC is
-- the empty string, even with system_context correctly set. With
-- NULLIF the empty GUC becomes NULL, the tenant disjunct is simply
-- false, and the policy denies (fails closed) instead of erroring.
--
-- Discovered by packages/integration-tests/src/
-- rls-system-context-sentinel.test.ts. The two fixes are separate
-- migrations because 20260629000000 had already been applied to
-- environments when this defect surfaced; editing an applied
-- migration causes Prisma checksum drift.
--
-- The predicate below is byte-for-byte the baseline's standard tenant
-- policy (20260522060000_rls_baseline, DO-block template).

-- notification_delivery -------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_delivery";
CREATE POLICY "tenant_isolation" ON "notification_delivery"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- access_review_snapshot ------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation" ON "access_review_snapshot";
CREATE POLICY "tenant_isolation" ON "access_review_snapshot"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- report_run ------------------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation" ON "report_run";
CREATE POLICY "tenant_isolation" ON "report_run"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );
