// Cross-tenant claim of organizations due for an NPI registry sync.
//
// The slice-5 scheduler runs cross-tenant (system context) and asks
// "which orgs should I dispatch a sync for on THIS tick?" The
// answer is computed entirely from `provider_sync_run` history +
// the presence of providers — no per-org cadence config table
// (yet). Cadence is a worker-level constant; if an operator wants a
// per-org override in the future, the right shape is a new
// `npi_sync_config` table queried by this function.
//
// Selection rules (all AND):
//   1. The org has at least one provider row. No point sweeping
//      orgs with no providers yet (a fresh tenant won't crash, but
//      it produces a noisy run row with `providersScanned = 0`).
//   2. The org does NOT have an `IN_PROGRESS` run already. The
//      slice-5 migration adds a PARTIAL UNIQUE INDEX to make this
//      a hard constraint, but we still filter here to avoid
//      handing the dispatcher work it can't accept.
//   3. EITHER the org has never had a non-IN_PROGRESS run (first
//      sync), OR the most-recent terminal run completed more than
//      `cadenceMs` ago.
//
// The query also returns `lastSuccessfulRunAt` for observability
// (the dispatcher logs it; future UI can render "last synced X
// days ago"). For never-synced orgs this is null.
//
// We do NOT use `FOR UPDATE SKIP LOCKED` here. Unlike
// `report_schedule`, there's no row to lock — the "claim" is the
// INSERT of an IN_PROGRESS run row, and the partial unique index
// is the lock. Read-only queries don't need SKIP LOCKED.
//
// Cross-tenant scope: runs in system context, returns rows from
// many tenants in one pass, then the scheduler loops per-row to
// enter tenancy + call `runNpiSyncForOrg`. Legitimate
// system-context bridge (matches the report-scheduler pattern).

import type { PrismaClient } from "@pharmax/database";

export interface DueOrgForNpiSyncRow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  /**
   * Most recent `completedAt` for a terminal-state run (COMPLETED
   * or PARTIAL). Null when the org has never completed a sync.
   * FAILED runs do NOT count — a stuck/abandoned FAILED run
   * should not push the next sync further into the future.
   */
  readonly lastSuccessfulRunAt: Date | null;
}

export interface ClaimDueOrgsForNpiSyncOptions {
  readonly batchSize: number;
  /**
   * Minimum time between syncs for the same org. Orgs whose last
   * successful run completed more recently than this are not
   * returned. Orgs that have never synced are always returned
   * (subject to `batchSize`).
   */
  readonly cadenceMs: number;
}

export type NpiSyncClaimClient = Pick<PrismaClient, "$queryRaw">;

interface RawRow {
  organizationId: string;
  organizationSlug: string;
  lastSuccessfulRunAt: Date | null;
}

export async function claimDueOrgsForNpiSync(
  client: NpiSyncClaimClient,
  options: ClaimDueOrgsForNpiSyncOptions
): Promise<DueOrgForNpiSyncRow[]> {
  const { batchSize, cadenceMs } = options;

  // Single statement so the database has a consistent snapshot
  // across the four predicates (provider exists, no IN_PROGRESS,
  // last successful run, cadence). Ordering by lastSuccessfulRunAt
  // NULLS FIRST then lastSuccessfulRunAt ASC means "never-synced
  // orgs first, then the orgs that are MOST overdue" — fair
  // queueing under cadence pressure.
  const rows = await client.$queryRaw<RawRow[]>`
    WITH last_terminal AS (
      SELECT
        "organizationId",
        MAX("completedAt") AS "lastSuccessfulRunAt"
      FROM "provider_sync_run"
      WHERE "status" IN ('COMPLETED', 'PARTIAL')
      GROUP BY "organizationId"
    ),
    orgs_in_progress AS (
      SELECT DISTINCT "organizationId"
      FROM "provider_sync_run"
      WHERE "status" = 'IN_PROGRESS'
    ),
    orgs_with_providers AS (
      SELECT DISTINCT "organizationId"
      FROM "provider"
    )
    SELECT
      o."id" AS "organizationId",
      o."slug" AS "organizationSlug",
      lt."lastSuccessfulRunAt"
    FROM "organization" o
    INNER JOIN orgs_with_providers owp ON owp."organizationId" = o."id"
    LEFT JOIN last_terminal lt ON lt."organizationId" = o."id"
    LEFT JOIN orgs_in_progress oip ON oip."organizationId" = o."id"
    WHERE oip."organizationId" IS NULL
      AND (
        lt."lastSuccessfulRunAt" IS NULL
        OR lt."lastSuccessfulRunAt" < NOW() - (${cadenceMs}::bigint * INTERVAL '1 millisecond')
      )
    ORDER BY lt."lastSuccessfulRunAt" ASC NULLS FIRST, o."id" ASC
    LIMIT ${batchSize}
  `;

  return rows.map((row) =>
    Object.freeze({
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      lastSuccessfulRunAt: row.lastSuccessfulRunAt,
    })
  );
}
