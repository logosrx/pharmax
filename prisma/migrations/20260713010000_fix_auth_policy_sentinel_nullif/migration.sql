-- Repair the five phase-6 auth-table RLS policies.
--
-- The phase6_auth_engine migration recreated BOTH defects that were
-- already repaired once for the phase-5 tables (see
-- 20260629000000_fix_system_context_sentinel and
-- 20260701000000_fix_phase5_policy_org_guc_nullif):
--
--   1. sentinel: compares pharmax.system_context to 'true', but
--      `applySystemSessionGuc` sets 'on' — so system-context access
--      is SILENTLY DENIED. The auth engine reads/writes these tables
--      in system context (sign-in resolves the user before any
--      tenant is known), so under the pharmax_app/pharmax_system
--      role cutover, SIGN-IN ITSELF fails.
--
--   2. missing NULLIF: casts the org GUC straight to uuid. The
--      system-context helper clears the org GUC to '' and Postgres
--      does not short-circuit OR in policy predicates, so ''::uuid
--      raises `invalid input syntax for type uuid: ""` on every
--      query while the GUC is empty.
--
-- Caught by packages/integration-tests/src/
-- rls-system-context-sentinel.test.ts (the catalog sweep exists
-- precisely to stop this template from regressing). The predicate
-- below is byte-for-byte the RLS baseline's canonical tenant policy.

DO $$
DECLARE
  t text;
  auth_tables text[] := ARRAY[
    'auth_session',
    'mfa_enrollment',
    'recovery_code',
    'password_history',
    'password_reset_token'
  ];
BEGIN
  FOREACH t IN ARRAY auth_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON %I
         USING (
           current_setting(''pharmax.system_context'', true) = ''on''
           OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
         )
         WITH CHECK (
           current_setting(''pharmax.system_context'', true) = ''on''
           OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid
         )',
      t
    );
  END LOOP;
END $$;
