-- migration: 20260616000000_phase3_provider_npi_sync
--
-- Slice 3 of the `SyncFromNpiRegistry` feature. Adds three new
-- tenant-scoped tables that the worker (slice 4) writes to:
--
--   1. provider_sync_run         — one row per worker invocation per
--                                  org. Carries start/complete
--                                  timestamps, summary metrics, and
--                                  a status enum.
--
--   2. provider_sync_check       — one row per (run, provider). The
--                                  per-check audit trail of what the
--                                  worker observed (CMS status, CMS
--                                  last-updated) and what action it
--                                  took. High volume — ~1k providers
--                                  per org × daily runs = ~365k
--                                  rows/year/org. Indexed for the
--                                  three common access patterns
--                                  (history-for-provider, contents-
--                                  of-run, all-actions-of-kind).
--                                  NOT partitioned yet; the index
--                                  shapes work either way and we'll
--                                  retrofit a monthly partition
--                                  scheme once row counts justify it
--                                  (10M+ band). The diff-engine slice
--                                  has 6 SyncAction kinds; we add a
--                                  7th value (`FETCH_FAILED`) to this
--                                  table's action enum because the
--                                  worker also persists per-NPI
--                                  CmsFetchResult failures here.
--
--   3. provider_sync_review_item — the operator review queue. The
--                                  worker writes a row whenever the
--                                  diff engine emits an action that
--                                  requires HUMAN judgment
--                                  (REACTIVATION_CANDIDATE,
--                                  NOT_FOUND_AT_CMS,
--                                  ENUMERATION_TYPE_MISMATCH per
--                                  slice 1's contract). At most one
--                                  OPEN row per (provider, kind) via
--                                  the partial unique index — if the
--                                  worker re-emits the same finding
--                                  in a later run before the
--                                  operator resolves the prior one,
--                                  the second insert is a no-op (the
--                                  worker catches P2002 and skips).
--                                  Snapshots (cmsSnapshot,
--                                  localSnapshot) are JSONB blobs
--                                  capturing the discovery-time
--                                  evidence so operators see what
--                                  was observed WHEN it was observed
--                                  — not the current state. NPPES
--                                  data is PUBLIC (no encryption);
--                                  the local snapshot is provider-
--                                  directory data which is NOT PHI.
--                                  `resolutionNotes` is operator-
--                                  provided free text and MAY carry
--                                  PHI (e.g. "noticed this when
--                                  patient X's order routed wrong");
--                                  the slice-6 resolution command
--                                  will redact it from command_log
--                                  the same way OrderCancellation
--                                  does for dispositionReasonText.
--
-- Why three tables and not one:
--   - The metrics on a run are aggregates; the per-check rows are
--     the disaggregated source. Joining `run × all-its-checks` is
--     the dashboard query; making the run row a SELECT-only
--     materialized view of the checks would force a single-source
--     refresh and complicate the "stuck run reaper" worker (slice 5+)
--     that needs to update `status` on still-IN_PROGRESS rows.
--   - The review_item queue has a fundamentally different access
--     pattern (operators querying by status + age, with mutation on
--     resolve/dismiss) than the append-only audit rows. Mixing them
--     would force every operator-UI query to filter by action kind.
--
-- Why no partition on provider_sync_check yet:
--   - The check row table is the only one with volume concerns. At
--     1k providers × daily runs × 5 orgs we're at ~1.8M rows/year.
--     The indexes are organizationId-first and benchmark fine
--     against a single unpartitioned table up to ~10M rows in our
--     workload (read-heavy, write-once, indexable).
--   - Adding partitioning later is an online operation (create new
--     partitioned table, copy in, swap names) and the FKs we add
--     here will need to be rewritten — but the application code
--     reads/writes via Prisma which is partition-agnostic, so the
--     migration is structurally manageable when we get there.
--   - Premature partitioning would commit us to a specific time
--     boundary (monthly vs. quarterly) before we know the access
--     pattern's hot/cold split.
--
-- RLS shape mirrors the baseline: ENABLE + FORCE on each table + one
-- PERMISSIVE `tenant_isolation` policy via the standard DO block on
-- the `pharmax.system_context` / `pharmax.organization_id` GUC pair.
-- The migration linter `scripts/check-migration-rls.ts` enforces
-- that the ENABLE + CREATE POLICY pairing exists on every CREATE
-- TABLE in this file.
--
-- FK actions: all RESTRICT. A provider, run, or check row referenced
-- by downstream audit data cannot be deleted out from under the
-- audit trail. Same invariant as OrderCancellation / OrderHold.

-- ---------------------------------------------------------------------
-- 1. New enums
-- ---------------------------------------------------------------------

-- Status of a sync run.
--   IN_PROGRESS: started, no completedAt yet. A stuck-run reaper
--                worker (slice 5+) sweeps these to FAILED if they
--                exceed the maximum expected runtime.
--   COMPLETED:   ran to completion with no per-NPI fetch failures.
--   PARTIAL:     ran to completion but some per-NPI fetches failed
--                (CmsFetchResult.ok=false). The run succeeded
--                structurally; the failed NPIs are recorded in
--                provider_sync_check with action=FETCH_FAILED and
--                will be retried in the next run.
--   FAILED:      aborted before completing all NPIs (e.g., CMS
--                hard-down, worker crashed, reaper-marked).
CREATE TYPE "ProviderSyncRunStatus" AS ENUM (
    'IN_PROGRESS',
    'COMPLETED',
    'PARTIAL',
    'FAILED'
);

-- What triggered the sync run.
--   CRON:     scheduled run (slice 5).
--   MANUAL:   operator-initiated from the admin UI (slice 6) — the
--             `triggeredByUserId` column is non-null for these.
--   BACKFILL: ad-hoc full re-sync of all providers (e.g., after a
--             schema change to ProviderUpdate, or first-time
--             provisioning for an org with imported provider data).
CREATE TYPE "ProviderSyncRunTrigger" AS ENUM (
    'CRON',
    'MANUAL',
    'BACKFILL'
);

-- The action the worker took for one (run, provider) pair. Mirrors
-- slice 1's `SyncAction.kind` discriminator (NONE / UPDATE /
-- DEACTIVATE / REACTIVATION_CANDIDATE / NOT_FOUND_AT_CMS /
-- ENUMERATION_TYPE_MISMATCH) with an additional `FETCH_FAILED` value
-- for the case where the CMS fetch itself failed and the diff
-- engine could not be run (CmsFetchResult.ok=false). The diff
-- engine never emits FETCH_FAILED; it's a worker-layer concept.
CREATE TYPE "ProviderSyncCheckAction" AS ENUM (
    'NONE',
    'UPDATE',
    'DEACTIVATE',
    'REACTIVATION_CANDIDATE',
    'NOT_FOUND_AT_CMS',
    'ENUMERATION_TYPE_MISMATCH',
    'FETCH_FAILED'
);

-- Which kind of human-review case this review item represents.
-- Subset of ProviderSyncCheckAction — only the actions the diff
-- engine emits that REQUIRE human judgment (per slice 1's contract:
-- "never auto-reactivate"). NONE, UPDATE, DEACTIVATE never produce
-- review items (the worker dispatches commands directly for those);
-- FETCH_FAILED never produces a review item (it's retried, not
-- reviewed).
CREATE TYPE "ProviderSyncReviewItemKind" AS ENUM (
    'REACTIVATION_CANDIDATE',
    'NOT_FOUND_AT_CMS',
    'ENUMERATION_TYPE_MISMATCH'
);

-- Open/resolved status of a review item.
--   OPEN:      visible in the operator queue; awaiting decision.
--   RESOLVED:  operator dispatched a command (Reactivate / Deactivate
--              / update NPI) that resolved the underlying issue.
--   DISMISSED: operator decided no action was needed (e.g., false
--              positive, the local row was actually correct).
CREATE TYPE "ProviderSyncReviewItemStatus" AS ENUM (
    'OPEN',
    'RESOLVED',
    'DISMISSED'
);

-- The specific resolution path taken when an OPEN review item is
-- closed. Set together with `resolvedAt` + `resolvedByUserId`
-- when status transitions away from OPEN.
--   REACTIVATED:                operator dispatched ReactivateProvider.
--   DEACTIVATED:                operator dispatched DeactivateProvider
--                               (typical for NOT_FOUND_AT_CMS after
--                               confirming the local row was an
--                               operator entry error).
--   NPI_CORRECTED:              operator fixed a typo'd NPI via
--                               Deactivate + Register (the immutable-
--                               NPI rule means an actual correction
--                               is a deactivate + new-record motion).
--   DISMISSED_AS_FALSE_POSITIVE: operator confirmed the local data is
--                               correct and CMS is wrong / behind.
--   DISMISSED_NO_ACTION:        operator decided no action is needed
--                               (provider retired, will handle in
--                               next billing cycle, etc.).
CREATE TYPE "ProviderSyncReviewItemResolution" AS ENUM (
    'REACTIVATED',
    'DEACTIVATED',
    'NPI_CORRECTED',
    'DISMISSED_AS_FALSE_POSITIVE',
    'DISMISSED_NO_ACTION'
);

-- ---------------------------------------------------------------------
-- 2. New table: provider_sync_run
--
--    Summary metrics carried denormalized on the row so dashboards
--    can answer "show me last week's run rates" without scanning the
--    per-check table. Counts are written by the worker as it
--    processes each provider; on COMPLETED transition they're final.
--
--    `errorMessage` and `errorMetadata` carry PharmaxError contents
--    (by contract, no PHI; the platform-core error class enforces).
--    Stored to make "why did the run fail?" answerable without
--    log-searching.
-- ---------------------------------------------------------------------

CREATE TABLE "provider_sync_run" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    "status" "ProviderSyncRunStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "triggeredBy" "ProviderSyncRunTrigger" NOT NULL,
    "triggeredByUserId" UUID,

    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    -- Total providers in scope for this run (the query result that
    -- the worker iterates over).
    "providersScanned" INTEGER NOT NULL DEFAULT 0,
    -- Subset of providersScanned where the worker actually queried
    -- CMS (less than scanned when the worker skips recently-synced
    -- providers via a freshness check — slice 4 may or may not
    -- implement this).
    "providersFetchedFromCms" INTEGER NOT NULL DEFAULT 0,

    -- Per-action counters. Sum should equal providersScanned (one
    -- check row per provider; one action per check). The worker
    -- updates these atomically as it writes each provider_sync_check
    -- row.
    "noChangeCount" INTEGER NOT NULL DEFAULT 0,
    "providersUpdated" INTEGER NOT NULL DEFAULT 0,
    "providersDeactivated" INTEGER NOT NULL DEFAULT 0,
    "reactivationCandidatesCreated" INTEGER NOT NULL DEFAULT 0,
    "notFoundAtCmsCount" INTEGER NOT NULL DEFAULT 0,
    "enumerationTypeMismatchCount" INTEGER NOT NULL DEFAULT 0,
    "fetchFailedCount" INTEGER NOT NULL DEFAULT 0,

    -- High-level error for FAILED runs. PHI-free (PharmaxError
    -- contract). Stored to make root-cause analysis self-contained
    -- without log-search.
    "errorMessage" TEXT,
    "errorMetadata" JSONB,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_sync_run_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. New table: provider_sync_check
--
--    The disaggregated source for per-provider audit. One row per
--    (run, provider). High volume — see top-of-file note on
--    partitioning.
--
--    `cmsLastUpdatedAt` and `cmsStatus` are denormalized from the
--    CmsNpiSnapshot the worker observed; nullable because the CMS
--    fetch may have failed or returned no result (NOT_FOUND_AT_CMS).
--    Carrying these on the row lets the operator UI show "CMS said
--    this on this date" without re-fetching from NPPES.
--
--    `dispatchedCommandLogId` is non-null when the worker dispatched
--    a command for this check (UPDATE -> UpdateProvider's command_log,
--    DEACTIVATE -> DeactivateProvider's command_log). Null when no
--    command was dispatched (NONE, all review-item actions,
--    FETCH_FAILED).
-- ---------------------------------------------------------------------

CREATE TABLE "provider_sync_check" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerSyncRunId" UUID NOT NULL,
    "providerId" UUID NOT NULL,

    -- Denormalized for query-without-join (and for the case where
    -- a future operator UI shows the historical check by NPI even
    -- though the local provider row may have been hard-deleted —
    -- which we don't do today, but the indirection is cheap).
    "npi" VARCHAR(10) NOT NULL,

    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" "ProviderSyncCheckAction" NOT NULL,

    -- Optional structured detail for the action. For NONE, one of
    -- "no_diff" / "both_inactive". For ENUMERATION_TYPE_MISMATCH,
    -- a string like "local=NPI-1, cms=NPI-2". For FETCH_FAILED,
    -- the CmsNppesClient error code (CMS_NPI_REGISTRY_*).
    "actionDetail" TEXT,

    -- Denormalized snapshot of what CMS reported for this NPI at
    -- check time. Null when CMS lookup failed or returned no result.
    "cmsStatus" CHAR(1),
    "cmsLastUpdatedAt" TIMESTAMP(3),

    -- Set when the worker dispatched a command for this check.
    "dispatchedCommandLogId" UUID,

    -- Set when action=FETCH_FAILED. PharmaxError contract guarantees
    -- no PHI in these fields.
    "errorCode" TEXT,
    "errorMetadata" JSONB,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_sync_check_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 4. New table: provider_sync_review_item
--
--    Operator review queue. One open row per (provider, kind) —
--    enforced by the partial unique index below.
--
--    `cmsSnapshot` and `localSnapshot` are JSONB blobs. We
--    deliberately do NOT add a JSONB GIN index because we never
--    query INTO the snapshots — they're displayed in the operator
--    UI as evidence, not searched. If a future requirement adds
--    "find all review items where the CMS practice was in state
--    XX", we add the index then.
-- ---------------------------------------------------------------------

CREATE TABLE "provider_sync_review_item" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "providerSyncRunId" UUID NOT NULL,
    "providerSyncCheckId" UUID NOT NULL,

    "kind" "ProviderSyncReviewItemKind" NOT NULL,
    "status" "ProviderSyncReviewItemStatus" NOT NULL DEFAULT 'OPEN',

    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Evidence shown to the operator. JSONB blobs of the slice-1
    -- diff inputs at discovery time.
    --
    -- cmsSnapshot is null for NOT_FOUND_AT_CMS (the whole point —
    -- CMS returned no result). Non-null otherwise.
    "cmsSnapshot" JSONB,
    "localSnapshot" JSONB NOT NULL,

    -- Resolution columns. All null when status='OPEN'; populated
    -- atomically on transition to RESOLVED/DISMISSED.
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" UUID,
    "resolution" "ProviderSyncReviewItemResolution",
    -- PHI-adjacent free text. Redacted from command_log by the
    -- slice-6 resolution command's `redactFields` (same pattern as
    -- OrderCancellation.dispositionReasonText).
    "resolutionNotes" TEXT,
    -- Command_log row of the command the operator dispatched to
    -- resolve, if any. Null for DISMISSED_* resolutions and for
    -- still-OPEN items.
    "resolvedCommandLogId" UUID,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_sync_review_item_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 5. Indexes
--
-- provider_sync_run:
--   - (organizationId, startedAt DESC) — "last N runs for this org"
--   - (organizationId, status) — for the stuck-run reaper sweep
--   - (organizationId, triggeredByUserId) — "what runs did <user>
--     trigger?" (sparse: only MANUAL runs have a non-null user)
--
-- provider_sync_check:
--   - (organizationId, providerSyncRunId) — "all checks in run X"
--     (the run-detail dashboard view)
--   - (organizationId, providerId, checkedAt DESC) — "sync history
--     for provider Y" (the provider-detail view)
--   - (organizationId, action, checkedAt DESC) — "all DEACTIVATE
--     actions last quarter" (the report view)
--   - (organizationId, npi, checkedAt DESC) — alternate lookup by
--     NPI (when the local provider row has been re-keyed)
--   - (organizationId, dispatchedCommandLogId) — "what sync caused
--     this command?" (the audit-traceback view; sparse)
--
-- provider_sync_review_item:
--   - (organizationId, kind, status, discoveredAt DESC) — the
--     primary queue view ("show me all OPEN reactivation candidates,
--     newest first")
--   - (organizationId, status, discoveredAt DESC) — the all-kinds
--     queue view
--   - (organizationId, providerId, kind) WHERE status = 'OPEN' —
--     PARTIAL UNIQUE: at most one open review per (provider, kind).
--     Also the worker's "is there already an open review for this?"
--     lookup index.
--   - (organizationId, resolvedByUserId, resolvedAt DESC) — "what
--     reviews has <user> resolved?" (sparse: only resolved items)
-- ---------------------------------------------------------------------

CREATE INDEX "provider_sync_run_organizationId_startedAt_idx"
    ON "provider_sync_run"("organizationId", "startedAt" DESC);
CREATE INDEX "provider_sync_run_organizationId_status_idx"
    ON "provider_sync_run"("organizationId", "status");
CREATE INDEX "provider_sync_run_organizationId_triggeredByUserId_idx"
    ON "provider_sync_run"("organizationId", "triggeredByUserId");

CREATE INDEX "provider_sync_check_organizationId_runId_idx"
    ON "provider_sync_check"("organizationId", "providerSyncRunId");
CREATE INDEX "provider_sync_check_organizationId_providerId_checkedAt_idx"
    ON "provider_sync_check"("organizationId", "providerId", "checkedAt" DESC);
CREATE INDEX "provider_sync_check_organizationId_action_checkedAt_idx"
    ON "provider_sync_check"("organizationId", "action", "checkedAt" DESC);
CREATE INDEX "provider_sync_check_organizationId_npi_checkedAt_idx"
    ON "provider_sync_check"("organizationId", "npi", "checkedAt" DESC);
CREATE INDEX "provider_sync_check_organizationId_commandLogId_idx"
    ON "provider_sync_check"("organizationId", "dispatchedCommandLogId");

CREATE INDEX "provider_sync_review_item_organizationId_kind_status_disc_idx"
    ON "provider_sync_review_item"("organizationId", "kind", "status", "discoveredAt" DESC);
CREATE INDEX "provider_sync_review_item_organizationId_status_disc_idx"
    ON "provider_sync_review_item"("organizationId", "status", "discoveredAt" DESC);
CREATE INDEX "provider_sync_review_item_organizationId_resolver_idx"
    ON "provider_sync_review_item"("organizationId", "resolvedByUserId", "resolvedAt" DESC);
CREATE UNIQUE INDEX "provider_sync_review_item_open_unique"
    ON "provider_sync_review_item"("organizationId", "providerId", "kind")
    WHERE "status" = 'OPEN';

-- ---------------------------------------------------------------------
-- 6. Foreign keys.
--    All RESTRICT. Audit-trail invariant: nothing referenced by a
--    sync row can be hard-deleted out from under the audit.
-- ---------------------------------------------------------------------

ALTER TABLE "provider_sync_run" ADD CONSTRAINT "provider_sync_run_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_run" ADD CONSTRAINT "provider_sync_run_triggeredByUserId_fkey"
    FOREIGN KEY ("triggeredByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_sync_check" ADD CONSTRAINT "provider_sync_check_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_check" ADD CONSTRAINT "provider_sync_check_runId_fkey"
    FOREIGN KEY ("providerSyncRunId") REFERENCES "provider_sync_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_check" ADD CONSTRAINT "provider_sync_check_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_check" ADD CONSTRAINT "provider_sync_check_commandLogId_fkey"
    FOREIGN KEY ("dispatchedCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_sync_review_item" ADD CONSTRAINT "provider_sync_review_item_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_review_item" ADD CONSTRAINT "provider_sync_review_item_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_review_item" ADD CONSTRAINT "provider_sync_review_item_runId_fkey"
    FOREIGN KEY ("providerSyncRunId") REFERENCES "provider_sync_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_review_item" ADD CONSTRAINT "provider_sync_review_item_checkId_fkey"
    FOREIGN KEY ("providerSyncCheckId") REFERENCES "provider_sync_check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_review_item" ADD CONSTRAINT "provider_sync_review_item_resolvedByUserId_fkey"
    FOREIGN KEY ("resolvedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_sync_review_item" ADD CONSTRAINT "provider_sync_review_item_resolvedCommandLogId_fkey"
    FOREIGN KEY ("resolvedCommandLogId") REFERENCES "command_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 7. Grants for application roles. Mirrors the baseline RLS pattern.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "provider_sync_run",
    "provider_sync_check",
    "provider_sync_review_item"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 8. Enable + FORCE row-level security.
-- ---------------------------------------------------------------------

ALTER TABLE "provider_sync_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_sync_run" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "provider_sync_check" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_sync_check" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "provider_sync_review_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_sync_review_item" FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 9. Tenant isolation policy. Identical shape to the baseline.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'provider_sync_run',
    'provider_sync_check',
    'provider_sync_review_item'
  ];
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
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

-- ---------------------------------------------------------------------
-- 10. Sanity comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "provider_sync_run" IS
  'NPI Registry sync run. One row per worker invocation per org. Carries start/complete timestamps + summary metrics + error metadata. status=IN_PROGRESS rows are swept to FAILED by the reaper (slice 5+) if they exceed the expected runtime ceiling.';
COMMENT ON TABLE "provider_sync_check" IS
  'Per-(run, provider) audit row. Written for every provider the worker checks, regardless of outcome. action mirrors slice 1 SyncAction.kind plus FETCH_FAILED. High volume; partition by month when row counts justify it (10M+ band).';
COMMENT ON TABLE "provider_sync_review_item" IS
  'Operator review queue. One row per finding that requires human judgment (REACTIVATION_CANDIDATE, NOT_FOUND_AT_CMS, ENUMERATION_TYPE_MISMATCH). Partial unique on (organizationId, providerId, kind) WHERE status=OPEN: at most one open review per (provider, kind). Worker re-emissions are no-ops via the unique constraint.';
