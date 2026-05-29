// NPI Registry sync scheduler — per-tick logic.
//
// Each tick:
//   1. In system context, query for organizations whose last
//      successful sync completed more than `cadenceMs` ago (or
//      that have never synced), AND that don't already have an
//      IN_PROGRESS run. See `claim-due-orgs-for-npi-sync.ts`.
//   2. For each org returned, resolve the per-org service user
//      (`npi-sync@<org-slug>.test`), enter that org's tenancy
//      frame, and invoke `runNpiSyncForOrg` with production
//      dispatch adapters (real command bus + command_log lookup).
//   3. Per-org failures are isolated:
//        - Missing service user      → SKIPPED (config error;
//                                       admin runs the seed).
//        - P2002 on run insert       → SKIPPED (lost a race to a
//                                       sibling worker pod; the
//                                       partial unique index
//                                       `provider_sync_run_active_unique`
//                                       guarantees only one wins).
//        - Anything `runNpiSyncForOrg` throws  → FAILED for this
//                                       org; loop continues. The
//                                       orchestrator marked the
//                                       run row FAILED itself, so
//                                       there's no orphan
//                                       IN_PROGRESS row.
//
// Why no bus command wrapping the per-org work: `runNpiSyncForOrg`
// already owns its own audit + outbox writes via the inner
// `UpdateProvider` / `DeactivateProvider` commands it dispatches.
// A bus command at this layer would add a noop outer tx — the
// scheduler is pure orchestration.
//
// Cross-tenant scope: identical pattern to `report-scheduler.ts`
// — system-context claim, per-org tenancy for dispatch. Legitimate
// system-context bridge.

import type { PrismaClient } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import {
  buildProductionDispatchers,
  runNpiSyncForOrg,
  type CmsNppesClient,
  type ProviderSyncPrismaSurface,
  type RunNpiSyncForOrgResult,
} from "@pharmax/providers";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

import {
  claimDueOrgsForNpiSync,
  type DueOrgForNpiSyncRow,
  type NpiSyncClaimClient,
} from "./claim-due-orgs-for-npi-sync.js";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

/**
 * Prisma surface required by the scheduler. Union of:
 *   - the claim query's `$queryRaw`
 *   - the orchestrator's tenant-scoped models
 *   - the dispatch adapter's `commandLog.findFirst`
 *   - the per-org actor + slug lookups (`organization`, `user`)
 *
 * Spelled out so unit tests can hand the scheduler a narrow fake
 * (matching report-scheduler's pattern).
 */
export type NpiSyncSchedulerPrismaSurface = NpiSyncClaimClient &
  ProviderSyncPrismaSurface &
  Pick<PrismaClient, "commandLog" | "organization" | "user">;

export interface NpiSyncSchedulerDeps {
  readonly client: NpiSyncSchedulerPrismaSurface;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly cmsClient: Pick<CmsNppesClient, "fetchManyByNpi">;
  /**
   * Local-part of the per-org service-user email. Defaults to
   * `npi-sync`; the full email is `${actorEmailLocalPart}@${org.slug}.test`
   * to match the seed convention. Production deployments will swap
   * the `.test` suffix when they pin a real domain.
   */
  readonly actorEmailLocalPart?: string;
}

export interface NpiSyncSchedulerOptions {
  /** Max orgs claimed per tick. */
  readonly batchSize: number;
  /**
   * Minimum interval between successful syncs for the same org.
   * The claim query filters out orgs synced more recently than
   * this. Default is daily (24h).
   */
  readonly cadenceMs: number;
  /**
   * Cap on providers scanned per org per run. `null` (or omitted)
   * means unlimited. Useful for the first deployment + backfills,
   * where ops want to ramp up the sync rate gradually.
   */
  readonly maxProvidersPerOrg?: number | null;
  /**
   * Batch size for CMS `fetchManyByNpi` fan-out. Passed through to
   * `runNpiSyncForOrg`. Default 50 (matches the orchestrator
   * default).
   */
  readonly cmsFetchBatchSize?: number;
}

export interface NpiSyncSchedulerTickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface NpiSyncScheduler {
  tick(): Promise<NpiSyncSchedulerTickResult>;
}

/**
 * Build the scheduler. The returned `tick()` is what the worker's
 * poll loop invokes.
 */
export function createNpiSyncScheduler(
  deps: NpiSyncSchedulerDeps,
  options: NpiSyncSchedulerOptions
): NpiSyncScheduler {
  const log = deps.logger.child({ component: "npi-sync-scheduler" });
  const actorEmailLocalPart = deps.actorEmailLocalPart ?? "npi-sync";
  const dispatchers = buildProductionDispatchers(deps.client);

  return {
    async tick(): Promise<NpiSyncSchedulerTickResult> {
      // Step 1 — system-context claim.
      const dueOrgs = await withSystemContext(
        "worker:npi-sync-scheduler:claim",
        async () =>
          await claimDueOrgsForNpiSync(deps.client, {
            batchSize: options.batchSize,
            cadenceMs: options.cadenceMs,
          })
      );

      if (dueOrgs.length === 0) {
        return Object.freeze({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
      }
      log.info("npi-sync-scheduler.claimed", { claimed: dueOrgs.length });

      let succeeded = 0;
      let failed = 0;
      let skipped = 0;

      // Step 2 — process each org sequentially. We do NOT parallelize
      // across orgs: each `runNpiSyncForOrg` already saturates the
      // CMS client's 8 req/s rate gate, so fan-out would just queue
      // up requests waiting on the same gate. Sequential keeps the
      // tick's resource shape predictable.
      for (const row of dueOrgs) {
        const outcome = await processOrg({
          client: deps.client,
          cmsClient: deps.cmsClient,
          clock: deps.clock,
          logger: deps.logger,
          actorEmailLocalPart,
          dispatchers,
          row,
          maxProvidersPerOrg: options.maxProvidersPerOrg ?? null,
          ...(options.cmsFetchBatchSize !== undefined
            ? { cmsFetchBatchSize: options.cmsFetchBatchSize }
            : {}),
        });
        if (outcome === "SUCCEEDED") succeeded += 1;
        else if (outcome === "FAILED") failed += 1;
        else skipped += 1;
      }

      return Object.freeze({
        claimed: dueOrgs.length,
        succeeded,
        failed,
        skipped,
      });
    },
  };
}

type Outcome = "SUCCEEDED" | "FAILED" | "SKIPPED";

interface ProcessOrgArgs {
  readonly client: NpiSyncSchedulerPrismaSurface;
  readonly cmsClient: Pick<CmsNppesClient, "fetchManyByNpi">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly actorEmailLocalPart: string;
  readonly dispatchers: ReturnType<typeof buildProductionDispatchers>;
  readonly row: DueOrgForNpiSyncRow;
  readonly maxProvidersPerOrg: number | null;
  readonly cmsFetchBatchSize?: number;
}

async function processOrg(args: ProcessOrgArgs): Promise<Outcome> {
  const log = args.logger.child({
    component: "npi-sync-scheduler",
    organizationId: args.row.organizationId,
    organizationSlug: args.row.organizationSlug,
  });

  // Step 2a — resolve the per-org service user. System context: we
  // haven't entered the org's frame yet because we don't have an
  // actor to enter as.
  const actor = await withSystemContext(
    "worker:npi-sync-scheduler:resolve-actor",
    async () =>
      await args.client.user.findFirst({
        where: {
          organizationId: args.row.organizationId,
          email: `${args.actorEmailLocalPart}@${args.row.organizationSlug}.test`,
        },
        select: { id: true },
      })
  );

  if (actor === null) {
    log.warn("npi-sync-scheduler.skipped_no_actor", {
      event: "npi-sync-scheduler.skipped_no_actor",
      reason: "NPI sync service user not seeded for org",
      expectedEmail: `${args.actorEmailLocalPart}@${args.row.organizationSlug}.test`,
    });
    return "SKIPPED";
  }

  const tenancy = buildTenancyContext({
    organizationId: args.row.organizationId,
    actor: { userId: actor.id, correlationId: ids.generateUlid() },
  });

  let result: RunNpiSyncForOrgResult | null = null;
  try {
    result = await withTenancyContext(tenancy, () =>
      runNpiSyncForOrg(
        {
          prisma: args.client,
          cmsClient: args.cmsClient,
          clock: args.clock,
          logger: args.logger,
          dispatchUpdateProvider: args.dispatchers.dispatchUpdateProvider,
          dispatchDeactivateProvider: args.dispatchers.dispatchDeactivateProvider,
        },
        {
          organizationId: args.row.organizationId,
          triggeredBy: "CRON",
          triggeredByUserId: null,
          ...(args.maxProvidersPerOrg !== null ? { maxProviders: args.maxProvidersPerOrg } : {}),
          ...(args.cmsFetchBatchSize !== undefined
            ? { cmsFetchBatchSize: args.cmsFetchBatchSize }
            : {}),
        }
      )
    );
  } catch (cause) {
    // Loss-of-race on the IN_PROGRESS partial unique index. Another
    // worker pod beat us to inserting the run row for this org;
    // skip silently. This path is benign by design — the sibling
    // pod will complete the run, and the next tick will see the
    // org as not-due.
    if (isPrismaUniqueViolation(cause)) {
      log.info("npi-sync-scheduler.skipped_active_run_race", {
        event: "npi-sync-scheduler.skipped_active_run_race",
      });
      return "SKIPPED";
    }

    // The orchestrator's outer try/catch normally writes the
    // FAILED status itself. If we end up here, EITHER:
    //   - The orchestrator re-threw a structural error after
    //     marking the run FAILED (expected path; nothing more to do).
    //   - The orchestrator failed BEFORE creating the run row
    //     (e.g. the initial `providerSyncRun.create` threw a
    //     non-P2002 DB error).
    // Both paths surface as FAILED at the dispatcher tally.
    const code = cause instanceof errors.PharmaxError ? cause.code : "NPI_SYNC_DISPATCH_FAILED";
    log.error("npi-sync-scheduler.dispatch_failed", {
      event: "npi-sync-scheduler.dispatch_failed",
      code,
      error: cause,
    });
    return "FAILED";
  }

  if (result.status === "FAILED") {
    // The orchestrator caught + finalized the FAILED status itself
    // but did not throw (e.g. CMS fetch wholesale failure that
    // still left counters intact). Tally as FAILED.
    log.error("npi-sync-scheduler.run_failed", {
      event: "npi-sync-scheduler.run_failed",
      runId: result.runId,
      summary: result.summary,
    });
    return "FAILED";
  }

  log.info("npi-sync-scheduler.run_completed", {
    event: "npi-sync-scheduler.run_completed",
    runId: result.runId,
    status: result.status,
    summary: result.summary,
  });
  return "SUCCEEDED";
}

/**
 * Detect a Prisma P2002 (unique constraint violation). Used to
 * downgrade the loss-of-race on `provider_sync_run_active_unique`
 * from FAILED to SKIPPED.
 *
 * Prisma errors aren't statically typed (the engine returns them
 * as bare objects with a `.code` field), so we shape-check rather
 * than `instanceof`-narrow.
 */
function isPrismaUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === "P2002"
  );
}
