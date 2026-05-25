-- =====================================================================
-- RLS BASELINE
--
-- The load-bearing tenant isolation control. Complements the
-- @pharmax/tenancy Prisma extension as defense in depth: even if a
-- bug lets a query bypass the extension (raw SQL, $queryRaw, future
-- ORM swap), the database itself refuses to return cross-tenant rows.
--
-- Two app roles are introduced. Migrations continue to run as the
-- existing superuser (postgres in dev, pharmax_migrator in prod);
-- application runtime connects as `pharmax_app`.
--
--   pharmax_app
--     - Subject to RLS (NOT BYPASSRLS).
--     - Allowed to read/write tenant rows that match the active
--       `pharmax.organization_id` session GUC.
--     - INSERT-only on `audit_log` (UPDATE/DELETE revoked).
--     - Default role for apps/web, apps/worker, scripts/*.
--
--   pharmax_system
--     - BYPASSRLS. Reserved for bootstrap commands (CreateOrganization,
--       data migrations) where the org id is not yet established or
--       multiple orgs are touched in one operation. Still cannot
--       UPDATE/DELETE `audit_log` — that immutability is a UNIVERSAL
--       invariant.
--     - Selected at runtime by the command bus via
--       `applySystemSessionGuc(tx)`, which sets the
--       `pharmax.system_context` session GUC.
--
-- Two session GUCs control the runtime decision:
--
--   pharmax.organization_id   uuid; the active tenant. Set by the
--                             tenancy middleware at the start of every
--                             transaction in a user context.
--   pharmax.system_context    'on' | unset; when 'on', RLS policies
--                             bypass the org-id check. Set by the bus
--                             at the start of every transaction in a
--                             system context. NEVER set by route
--                             handlers directly.
--
-- Policy shape (every tenant table gets one PERMISSIVE policy):
--
--   USING (
--     current_setting('pharmax.system_context', true) = 'on'
--     OR <tenant_predicate>
--   )
--   WITH CHECK (same)
--
-- `<tenant_predicate>` is:
--   - `id = current_setting('pharmax.organization_id', true)::uuid`
--     for the `organization` table.
--   - `"organizationId" = current_setting('pharmax.organization_id', true)::uuid`
--     for everything else.
--
-- `current_setting(..., true)` returns NULL when the GUC is unset
-- (the `true` is the "missing_ok" flag). NULL fails the predicate
-- (NULL = anything → NULL → not true), so a connection that forgot
-- to set the GUC sees zero rows AND cannot write — fail-closed.
--
-- Audit-log immutability is enforced TWICE:
--   1. RLS policy below only permits INSERT and SELECT (no UPDATE,
--      DELETE policies defined → those operations are denied by RLS
--      because there is no permissive policy for them).
--   2. Explicit `REVOKE UPDATE, DELETE ON audit_log` from both app
--      roles. Defense in depth: a future "allow updates on audit_log"
--      regression would have to remove both controls.
--
-- Dev note: `postgres` is a SUPERUSER on local dev and therefore
-- automatically BYPASSRLS. The migration adds the roles and policies
-- but local dev continues to work unchanged. Production flips the
-- app connection string to `pharmax_app`. See README "Database roles".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Application roles.
--    Created as NOLOGIN here; ops sets a password / connection method
--    out of band (e.g. `ALTER ROLE pharmax_app WITH LOGIN PASSWORD '...';`
--    or IAM auth in RDS).
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharmax_app') THEN
    CREATE ROLE pharmax_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharmax_system') THEN
    CREATE ROLE pharmax_system NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. Schema-level grants.
--    USAGE on the schema, plus default privileges so future tables
--    created in this schema inherit the right base grants.
-- ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 3. Per-table grants.
--    Standard tenant tables get full DML. Audit gets INSERT + SELECT
--    only. Junctions and system tables follow their access pattern.
-- ---------------------------------------------------------------------

-- Tenant-scoped tables (18) — full DML subject to RLS below.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    organization,
    pharmacy_site,
    clinic,
    team,
    bucket,
    workstation,
    "user",
    role,
    user_role,
    workflow_policy,
    command_log,
    order_event,
    event_outbox,
    idempotency_key,
    stripe_customer,
    invoice,
    invoice_line
TO pharmax_app, pharmax_system;

-- audit_log — INSERT + SELECT only. UPDATE/DELETE are PERMANENTLY
-- denied because audit log immutability is a SOC 2 control.
GRANT SELECT, INSERT ON TABLE audit_log TO pharmax_app, pharmax_system;
REVOKE UPDATE, DELETE ON TABLE audit_log FROM pharmax_app, pharmax_system;

-- Non-tenant tables — see prisma/migrations/rls-exempt.txt for the
-- rationale of each entry.
GRANT SELECT ON TABLE permission TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE role_permission TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_site TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE ON TABLE stripe_webhook_event TO pharmax_app, pharmax_system;

-- Sequences — required so INSERTs that rely on identity columns work.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 4. Enable + FORCE row-level security on every tenant-scoped table.
--    FORCE means even the table owner is subject to RLS — without
--    this, the migrator (or postgres in dev) would bypass policies
--    when running utility queries from psql, masking misconfigurations.
-- ---------------------------------------------------------------------

ALTER TABLE organization      ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization      FORCE  ROW LEVEL SECURITY;
ALTER TABLE pharmacy_site     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_site     FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinic            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic            FORCE  ROW LEVEL SECURITY;
ALTER TABLE team              ENABLE ROW LEVEL SECURITY;
ALTER TABLE team              FORCE  ROW LEVEL SECURITY;
ALTER TABLE bucket            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bucket            FORCE  ROW LEVEL SECURITY;
ALTER TABLE workstation       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workstation       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "user"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE role              ENABLE ROW LEVEL SECURITY;
ALTER TABLE role              FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_role         ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role         FORCE  ROW LEVEL SECURITY;
ALTER TABLE workflow_policy   ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_policy   FORCE  ROW LEVEL SECURITY;
ALTER TABLE command_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_log       FORCE  ROW LEVEL SECURITY;
ALTER TABLE order_event       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_event       FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log         FORCE  ROW LEVEL SECURITY;
ALTER TABLE event_outbox      ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox      FORCE  ROW LEVEL SECURITY;
ALTER TABLE idempotency_key   ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key   FORCE  ROW LEVEL SECURITY;
ALTER TABLE stripe_customer   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_customer   FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoice           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice           FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoice_line      ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line      FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 5. Policies.
--    Single PERMISSIVE policy per table named `tenant_isolation`.
--    Audit_log has TWO policies (SELECT-only + INSERT-only) so the
--    absence of UPDATE/DELETE policies is what blocks those ops —
--    matching the explicit REVOKE above as defense in depth.
-- ---------------------------------------------------------------------

-- Organization is special: filtered by `id`, not `organization_id`.
CREATE POLICY tenant_isolation ON organization
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR id = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR id = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- Standard tenant policy — every other tenant-scoped table.
DO $$
DECLARE
  t text;
  -- Tables that use the standard "organizationId" column. Kept in
  -- this DO block so adding a new tenant table is a one-line change.
  std_tables text[] := ARRAY[
    'pharmacy_site',
    'clinic',
    'team',
    'bucket',
    'workstation',
    'user',
    'role',
    'user_role',
    'workflow_policy',
    'command_log',
    'order_event',
    'event_outbox',
    'idempotency_key',
    'stripe_customer',
    'invoice',
    'invoice_line'
  ];
BEGIN
  FOREACH t IN ARRAY std_tables LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ') '
      'WITH CHECK ('
      '  current_setting(''pharmax.system_context'', true) = ''on'' '
      '  OR "organizationId" = NULLIF(current_setting(''pharmax.organization_id'', true), '''')::uuid'
      ');',
      t
    );
  END LOOP;
END
$$;

-- audit_log: SELECT under tenant scope, INSERT under tenant scope;
-- UPDATE/DELETE are NOT defined as policies, so RLS denies them.
CREATE POLICY tenant_isolation_select ON audit_log
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON audit_log
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 6. Sanity comments.
--    Anyone running `\d+ <table>` in psql will see this and know RLS
--    is intentional, not vestigial.
-- ---------------------------------------------------------------------

COMMENT ON ROLE pharmax_app IS
  'Application connection role. Subject to RLS. Set pharmax.organization_id (and pharmax.system_context for bootstrap) at the start of every transaction.';
COMMENT ON ROLE pharmax_system IS
  'Bootstrap role. BYPASSRLS, but still cannot UPDATE/DELETE audit_log (immutability invariant).';
