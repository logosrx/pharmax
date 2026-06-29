-- Fix RLS system-context sentinel mismatch.
--
-- The session-GUC helper `applySystemSessionGuc` sets
--   set_config('pharmax.system_context', 'on', true)
-- (see packages/tenancy/src/session-guc.ts). The RLS baseline and
-- most table policies test for `= 'on'`. Three Phase-5 tables were
-- created with policies testing `= 'true'` instead:
--
--   * notification_delivery   (20260618000000)
--   * access_review_snapshot  (20260615000000)
--   * report_run              (20260614000000)
--
-- Because 'on' != 'true', the system-context bypass disjunct never
-- matched on those tables under the RLS-subject `pharmax_app` role,
-- so legitimate system-context reads/writes (e.g. the Resend webhook
-- resolving notification_delivery cross-tenant, web-side report_run
-- system reads) were silently DENIED. This is an over-deny (fail
-- closed) — never a data leak — but it breaks intended flows and
-- leaves RLS semantics inconsistent across tables.
--
-- This migration drops and recreates the three `tenant_isolation`
-- policies with the correct `'on'` sentinel so they match every
-- other policy and the GUC the application actually sets. The tenant
-- predicate is unchanged; this only restores the intended bypass for
-- the BYPASSRLS-equivalent system context.

-- notification_delivery -------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_delivery";
CREATE POLICY "tenant_isolation" ON "notification_delivery"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- access_review_snapshot ------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation" ON "access_review_snapshot";
CREATE POLICY "tenant_isolation" ON "access_review_snapshot"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );

-- report_run ------------------------------------------------------------
DROP POLICY IF EXISTS "tenant_isolation" ON "report_run";
CREATE POLICY "tenant_isolation" ON "report_run"
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
  );
