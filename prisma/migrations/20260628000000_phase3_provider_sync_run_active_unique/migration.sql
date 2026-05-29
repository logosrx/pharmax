-- migration: 20260628000000_phase3_provider_sync_run_active_unique
--
-- Slice 5 follow-on to slice 3 (provider_sync_run table).
--
-- The slice-5 cron scheduler runs cross-tenant and can fire two
-- workers against the same org if a deployment has more than one
-- worker pod (HA topology) — both workers select "orgs with no
-- IN_PROGRESS run" concurrently, both see the org as eligible,
-- and both INSERT an IN_PROGRESS row. Without this constraint the
-- result is two parallel sync runs writing per-check rows + racing
-- on UpdateProvider/DeactivateProvider dispatches.
--
-- A PARTIAL UNIQUE INDEX over (organizationId) WHERE status =
-- 'IN_PROGRESS' makes "at most one active sync per org" a database
-- invariant. The scheduler's dispatcher catches P2002 on the
-- run-create call and treats it as a benign loss-of-race (skip
-- this org for this tick).
--
-- Mirrors the slice-3 pattern for `provider_sync_review_item_open_unique`:
-- partial unique on the "open" subset of the table, so historical
-- rows (COMPLETED / PARTIAL / FAILED) are unaffected and a single
-- org accumulates one row per run forever.

CREATE UNIQUE INDEX "provider_sync_run_active_unique"
    ON "provider_sync_run"("organizationId")
    WHERE "status" = 'IN_PROGRESS';
