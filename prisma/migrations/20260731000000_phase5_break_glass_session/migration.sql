-- migration: 20260731000000_phase5_break_glass_session
--
-- Break-glass session + action ledger (@pharmax/security). Promotes
-- the schema described in packages/security/src/break-glass/SCHEMA.md
-- from a port-backed design doc to real tables, unblocking:
--
--   break_glass_session — lifecycle envelope for one `pharmax_system`
--                         bypass session (who, why, which ticket,
--                         four-eyes approver, hard duration cap).
--   break_glass_action  — one row per database operation executed
--                         inside the session (what they did with the
--                         keys, exactly, in order).
--
-- Break-glass SESSION (this migration) is distinct from break-glass
-- GRANT (@pharmax/rbac): a grant elevates ONE actor's privileges for
-- one permission; a session opens an RLS-bypassing system context for
-- cross-tenant forensic / repair work and records every op.
--
-- RLS: both tables are INTENTIONALLY platform-level (recorded in
-- rls-exempt.txt). Sessions cross all tenants by definition — there
-- is no organizationId to back a tenant predicate. Isolation is
-- enforced one layer up: only system-context code paths in
-- @pharmax/security touch these models, and the Prisma tenancy
-- extension excludes them from auto-scoping (TENANT_EXCLUDED_MODELS).
--
-- Append-only evidence: DELETE is granted to NEITHER application
-- role on either table; UPDATE is granted only on the session row
-- (the close writes closedAt + resolution) and NOT on actions.
--
-- PHI: none by construction. `reason`, `resolution`, `actionLabel`,
-- and `parameters` are PHI-redacted at the caller per policy;
-- `ticketUrl` is an operator artifact.

-- ---------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------

CREATE TABLE "break_glass_session" (
    -- ULID encoded as uuid, caller-supplied (sortable by open time).
    "id"                 UUID         NOT NULL,
    "requestedByUserId"  UUID         NOT NULL,
    -- Second engineer (four-eyes). NULL until approval lands.
    "approvedByUserId"   UUID,
    -- REQUIRED link to the incident / change ticket. Stored verbatim.
    "ticketUrl"          TEXT         NOT NULL,
    -- REQUIRED free-form summary. PHI-safe by policy.
    "reason"             TEXT         NOT NULL,
    "openedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"           TIMESTAMP(3),
    -- Final summary written at close time. Required when closedAt is
    -- set (enforced at the @pharmax/security command layer).
    "resolution"         TEXT,
    "maxDurationMinutes" INTEGER      NOT NULL DEFAULT 60,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "break_glass_action" (
    "id"           UUID         NOT NULL,
    "sessionId"    UUID         NOT NULL,
    "actionLabel"  TEXT         NOT NULL,
    -- PHI-redacted parameters. Caller is responsible for redaction.
    "parameters"   JSONB,
    "success"      BOOLEAN      NOT NULL,
    "errorMessage" TEXT,
    -- When the action dispatched a command, the resulting command_log
    -- id — the join back to the standard command ledger.
    "commandLogId" UUID,
    "startedAt"    TIMESTAMP(3) NOT NULL,
    "completedAt"  TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_action_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 2. Indexes.
-- ---------------------------------------------------------------------

-- Recent-sessions report (nightly digest, quarterly access review).
CREATE INDEX "break_glass_session_openedAt_idx"
    ON "break_glass_session"("openedAt" DESC);

-- Fast lookup of OPEN sessions. Partial index — Prisma schema syntax
-- cannot express it, so it lives here only (mirrors the
-- workflow_policy_active_unique precedent).
CREATE INDEX "break_glass_session_open_idx"
    ON "break_glass_session"("closedAt")
    WHERE "closedAt" IS NULL;

-- Replay one session's actions in order.
CREATE INDEX "break_glass_action_sessionId_startedAt_idx"
    ON "break_glass_action"("sessionId", "startedAt");

-- Join back to the standard command log.
CREATE INDEX "break_glass_action_commandLogId_idx"
    ON "break_glass_action"("commandLogId");

-- ---------------------------------------------------------------------
-- 3. Foreign keys. RESTRICT everywhere — sessions and actions are
--    append-only audit evidence; nothing may cascade them away.
-- ---------------------------------------------------------------------

ALTER TABLE "break_glass_session"
    ADD CONSTRAINT "break_glass_session_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "break_glass_session"
    ADD CONSTRAINT "break_glass_session_approvedByUserId_fkey"
    FOREIGN KEY ("approvedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "break_glass_action"
    ADD CONSTRAINT "break_glass_action_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "break_glass_session"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "break_glass_action"
    ADD CONSTRAINT "break_glass_action_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants. Deliberately NARROWER than the baseline:
--      - no DELETE on either table (append-only evidence),
--      - no UPDATE on break_glass_action (rows are immutable),
--      - UPDATE on break_glass_session only for the close write.
--    Both application roles receive the grants because system-context
--    is a GUC-based frame, not a connection-role switch — the
--    @pharmax/security module is the only code path that touches
--    these models.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "break_glass_session"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT ON TABLE "break_glass_action"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Sanity comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "break_glass_session" IS
  'Break-glass session envelope (@pharmax/security). One row per pharmax_system RLS-bypass session: requester, four-eyes approver, incident ticket, reason, hard duration cap, close resolution. Platform-level (RLS-exempt, see rls-exempt.txt) because sessions cross all tenants by definition. Append-only: no DELETE grant.';

COMMENT ON TABLE "break_glass_action" IS
  'Break-glass action ledger (@pharmax/security). One immutable row per database operation executed inside a break-glass session, with PHI-redacted parameters, outcome, and an optional join to command_log. INSERT-only at the grant layer.';
