-- migration: 20260614000000_phase5_report_run
--
-- Records every report execution: who ran what, with which
-- parameters, against which date window, and how many rows came
-- back. The SOC 2 question "what reports has operator X run this
-- quarter" is one indexed lookup on (organizationId, runByUserId,
-- generatedAt) once this table exists.
--
-- Why a dedicated table (vs. just an audit_log row):
--   - audit_log records "an action happened"; report_run records
--     enough metadata to RE-RUN the same query for verification.
--     The `parameters` JSONB column is the load-bearing field
--     for that — the original date range + filters are pinned.
--   - Downstream slices (scheduled-run worker, "view past run"
--     UI, billing on report executions) all need a row-keyed
--     handle. audit_log is append-only-by-design but its primary
--     key is a sequence number, not a stable id callers should
--     reference.
--
-- Storage shape:
--   - `parameters`        — JSONB, the operator's exact input.
--     Validated against the report's Zod schema before persist,
--     so we know it's the canonical shape.
--   - `aggregates`        — JSONB, the result's `aggregates` map
--     (totalCount, distinctGroups, etc.). One row per report run
--     is small; the full result rows are NOT persisted (re-run
--     on download; see the slice plan note).
--   - `rowCount`          — Int, denormalized from
--     `aggregates.totalCount` for indexable filtering ("show me
--     all runs that returned >0 rows").
--   - `runByUserId`       — Pharmax user id who ran the report.
--     Nullable: future scheduled-run worker may set this to NULL
--     and use `runViaScheduleId` instead (the per-org service
--     user is the actor in the bus + audit chain, this column
--     captures the OPERATOR side).
--   - `runViaScheduleId`  — reserved for the future scheduled-run
--     table; nullable string for now (no FK yet — the
--     `report_schedule` table will land in its own slice and add
--     a FK constraint then).
--
-- Indexes optimized for two reads:
--   - "show me my org's recent runs": (organizationId, generatedAt DESC)
--   - "show me runs of report X": (organizationId, reportId, generatedAt DESC)
--   - "show me operator's run history": (organizationId, runByUserId, generatedAt DESC)
--
-- RLS: standard tenant_isolation policy keyed on the existing
-- pharmax.system_context / pharmax.organization_id GUC pair —
-- matches the rest of the tenant-scoped tables.

CREATE TABLE "report_run" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"      UUID         NOT NULL,
    "reportId"            TEXT         NOT NULL,
    "reportVersion"       INTEGER      NOT NULL,
    "parameters"          JSONB        NOT NULL,
    "aggregates"          JSONB        NOT NULL,
    "rowCount"            INTEGER      NOT NULL,
    "windowFrom"          TIMESTAMP(3) NOT NULL,
    "windowTo"            TIMESTAMP(3) NOT NULL,
    "generatedAt"         TIMESTAMP(3) NOT NULL,
    "runByUserId"         UUID,
    "runViaScheduleId"    TEXT,
    "commandLogId"        UUID         NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_run_org_generated_idx"
    ON "report_run"("organizationId", "generatedAt" DESC);
CREATE INDEX "report_run_org_report_generated_idx"
    ON "report_run"("organizationId", "reportId", "generatedAt" DESC);
CREATE INDEX "report_run_org_user_generated_idx"
    ON "report_run"("organizationId", "runByUserId", "generatedAt" DESC)
    WHERE "runByUserId" IS NOT NULL;

ALTER TABLE "report_run"
    ADD CONSTRAINT "report_run_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "report_run"
    ADD CONSTRAINT "report_run_runByUserId_fkey"
    FOREIGN KEY ("runByUserId") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "report_run"
    ADD CONSTRAINT "report_run_commandLogId_fkey"
    FOREIGN KEY ("commandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT;

ALTER TABLE "report_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_run" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "report_run"
    USING (
        current_setting('pharmax.system_context', true) = 'true'
        OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'true'
        OR "organizationId" = current_setting('pharmax.organization_id', true)::uuid
    );
