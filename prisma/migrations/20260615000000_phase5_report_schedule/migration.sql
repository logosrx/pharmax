-- migration: 20260615000000_phase5_report_schedule
--
-- Schedule definitions for unattended report execution. One row
-- per (organization, report, named schedule) combination.
--
-- The worker tick (`apps/worker/src/drains/report-scheduler.ts`)
-- claims due rows via
--   SELECT … FOR UPDATE SKIP LOCKED
--   WHERE status = 'ACTIVE' AND nextRunAt <= NOW()
-- and dispatches RunReport for each. After a successful run the
-- tick recomputes nextRunAt from the cron expression and updates
-- the row in the same tx.
--
-- Why this lives next to report_run rather than in a generic
-- "scheduled jobs" table:
--   - The only thing we schedule today is reports. A generic
--     job scheduler would invent extension points we don't need
--     and obscure the actual operational contract.
--   - The `reportId` + `parametersTemplate` shape is specific
--     to the reports domain; the cron + nextRunAt machinery is
--     the only generic piece.
--
-- Column rationale:
--   - `name`               — operator-friendly label so the
--     /ops/admin/report-schedules list reads like a calendar.
--     Unique per (org, reportId) so admins can't accidentally
--     create two "Weekly Monday morning" schedules for the same
--     report.
--   - `cronExpression`     — 5-field standard cron, validated by
--     cron-parser inside CreateReportSchedule. Storing as TEXT
--     keeps the validation outside the DB; a runtime parse on
--     each worker tick catches drift after manual SQL changes.
--   - `timezone`           — IANA timezone (`America/New_York`,
--     etc.). Cron expressions are timezone-bound — "0 9 * * 1"
--     means 9am Monday in WHICH local time? — and pharmacy
--     operations are site-local, not UTC-local.
--   - `parametersTemplate` — JSONB with the report's parameter
--     shape PLUS support for relative-date placeholders
--     (`{ "from": "now-30d", "to": "now" }`). The placeholder
--     resolver runs at tick time, so a single schedule produces
--     a fresh window on every run.
--   - `status`             — ACTIVE / PAUSED / DISABLED. PAUSED
--     keeps the schedule visible + editable but the worker
--     skips it; DISABLED is a soft-delete (admin can resurrect).
--   - `lastRunAt`          — most recent tick that DISPATCHED
--     (NOT most recent successful — we update lastRunAt before
--     the dispatch so a crash mid-dispatch doesn't infinite-loop
--     the schedule).
--   - `lastRunStatus`      — SUCCEEDED / FAILED / SKIPPED. Drives
--     the admin UI's health badge.
--   - `lastRunReportRunId` — pointer to the report_run row for
--     the most recent SUCCEEDED dispatch (null if never run or
--     last was FAILED/SKIPPED).
--   - `nextRunAt`          — denormalized cron-next-fire time;
--     indexed for the worker's claim query. Recomputed after
--     every tick.
--   - `runCount`           — total dispatches. Cheap denormalized
--     counter for "is this schedule actually doing anything"
--     audit questions.
--
-- RLS: standard tenant_isolation pattern.

CREATE TYPE "ReportScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');
CREATE TYPE "ReportScheduleRunStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'SKIPPED');

CREATE TABLE "report_schedule" (
    "id"                  UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"      UUID                       NOT NULL,
    "name"                TEXT                       NOT NULL,
    "reportId"            TEXT                       NOT NULL,
    "cronExpression"      TEXT                       NOT NULL,
    "timezone"            TEXT                       NOT NULL DEFAULT 'UTC',
    "parametersTemplate"  JSONB                      NOT NULL,
    "status"              "ReportScheduleStatus"     NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt"           TIMESTAMP(3),
    "lastRunStatus"       "ReportScheduleRunStatus",
    "lastRunReportRunId"  UUID,
    "lastRunErrorCode"    TEXT,
    "nextRunAt"           TIMESTAMP(3)               NOT NULL,
    "runCount"            INTEGER                    NOT NULL DEFAULT 0,
    "createdByUserId"     UUID                       NOT NULL,
    "createCommandLogId"  UUID                       NOT NULL,
    "createdAt"           TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3)               NOT NULL,

    CONSTRAINT "report_schedule_pkey" PRIMARY KEY ("id")
);

-- One named schedule per (org, reportId, name). Two "Weekly Monday"
-- schedules for the same report is almost always operator error.
CREATE UNIQUE INDEX "report_schedule_org_report_name_idx"
    ON "report_schedule"("organizationId", "reportId", "name");

-- The worker's claim query. Partial index — DISABLED rows are
-- soft-deleted and we don't want them in the hot path.
CREATE INDEX "report_schedule_due_idx"
    ON "report_schedule"("organizationId", "nextRunAt")
    WHERE "status" = 'ACTIVE';

-- Admin UI list — sort by lastRunAt to surface "freshly-failed"
-- schedules near the top.
CREATE INDEX "report_schedule_org_last_run_idx"
    ON "report_schedule"("organizationId", "lastRunAt" DESC);

ALTER TABLE "report_schedule"
    ADD CONSTRAINT "report_schedule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT;
ALTER TABLE "report_schedule"
    ADD CONSTRAINT "report_schedule_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "report_schedule"
    ADD CONSTRAINT "report_schedule_createCommandLogId_fkey"
    FOREIGN KEY ("createCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT;
ALTER TABLE "report_schedule"
    ADD CONSTRAINT "report_schedule_lastRunReportRunId_fkey"
    FOREIGN KEY ("lastRunReportRunId") REFERENCES "report_run"("id") ON DELETE SET NULL;

ALTER TABLE "report_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_schedule" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "report_schedule"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );
