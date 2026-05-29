-- migration: 20260616000000_phase5_report_schedule_notifications
--
-- Adds notification preferences to report_schedule. A schedule
-- that fires but tells nobody is just an audit row; this slice
-- closes the loop so the worker tick fans the run completion out
-- to a configured recipient list via @pharmax/notifications.
--
-- Column rationale:
--   - `recipients TEXT[]` — operator email addresses, plaintext.
--     These are admin/billing-contact emails (NOT patient PHI):
--     a recipient list of `["billing@acme.test"]` says "tell the
--     org's billing inbox", not "tell patient X". The
--     notification layer's PHI gate (templates/template-registry
--     PHI_SENTINEL_PREFIX_KEYS) catches context-level PHI; the
--     recipient address itself is operator metadata.
--
--     Stored as a PostgreSQL TEXT[] (not a JSONB array) so the
--     admin UI's "list recipients for schedules that include
--     billing@acme.test" filter is one indexed lookup with
--     `ANY()` rather than a JSON containment scan if we ever
--     add such a query.
--
--   - `notifyOn ReportScheduleNotifyOn` — three modes:
--     - ALWAYS       — fire notification on every dispatch
--                      regardless of outcome. The default for new
--                      schedules; matches the operator's intuition
--                      that "I asked for a weekly report and I
--                      want the weekly report."
--     - FAILURE_ONLY — fire only when the run did NOT succeed
--                      (FAILED or SKIPPED). Useful for noisy
--                      schedules where the happy path is "no
--                      news is good news" — e.g. an hourly
--                      anomaly report.
--     - NEVER        — disable notifications without disabling
--                      the schedule (useful while debugging a
--                      recipient list change). The audit trail
--                      still shows the runs.
--
-- Defaults: `recipients = '{}'`, `notifyOn = ALWAYS`. Existing
-- rows seeded before this slice get ALWAYS + empty recipients;
-- the handler skips runs with no recipients (the empty list is
-- the "scheduled but silent" mode preserved by the previous
-- slice's behavior).

CREATE TYPE "ReportScheduleNotifyOn" AS ENUM ('ALWAYS', 'FAILURE_ONLY', 'NEVER');

ALTER TABLE "report_schedule"
  ADD COLUMN "recipients" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "notifyOn"   "ReportScheduleNotifyOn" NOT NULL DEFAULT 'ALWAYS';
