// NPI sync stuck-run reaper.
//
// `provider_sync_run` rows in `IN_PROGRESS` past a configured
// runtime ceiling are abandoned — the worker that started the run
// crashed mid-flight, was killed by an orchestrator scaling event,
// or hit a non-PharmaxError exception that escaped the
// orchestrator's outer try/catch (which should never happen, but
// the database invariant has to be robust to bugs in application
// code).
//
// Without the reaper, the partial unique index
// `provider_sync_run_active_unique` would refuse the next sync for
// the affected org indefinitely. The reaper sweeps stuck rows to
// `FAILED` so the scheduler can claim the org again on its next
// tick.
//
// Design rules:
//
//   1. Cross-tenant. The reaper runs in system context and
//      considers IN_PROGRESS rows from every org in one SQL pass.
//      Per-org tenancy entry would gain nothing — there are no
//      side effects beyond the row update itself (no audit_log,
//      no event_outbox, no command_log — a stuck run that never
//      finished has no real "completed at" event to broadcast).
//
//   2. Stamp explicit metadata. The reaped row carries
//      `errorMessage = "sync run exceeded runtime ceiling"` and
//      `errorMetadata = { reaper: true, runtimeCeilingMs, reapedAt }`
//      so an operator inspecting the dashboard can distinguish
//      a stuck-run reap from a "the orchestrator caught and
//      finalized FAILED" outcome.
//
//   3. The reaper uses `updateMany` rather than `update + loop`.
//      Prisma's `updateMany` produces a single UPDATE statement
//      with the WHERE predicate; concurrent reapers (multi-pod)
//      converge to the same result because they all set the same
//      target status. No row-level locks required — `updateMany`
//      with no nested mutation is safe to run concurrently
//      against the same rows.
//
//   4. Idempotent at the row level: a reaped row already has
//      `status = 'FAILED'` after the first sweep, so the WHERE
//      predicate (`status = 'IN_PROGRESS'`) excludes it from
//      future sweeps. The predicate IS the idempotency guard.

import type { PrismaClient } from "@pharmax/database";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

export interface ReapStuckNpiSyncRunsDeps {
  readonly client: Pick<PrismaClient, "providerSyncRun">;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface ReapStuckNpiSyncRunsOptions {
  /**
   * Maximum allowed runtime for a single `provider_sync_run`. Any
   * row in `IN_PROGRESS` older than this is treated as
   * abandoned and reaped to `FAILED`.
   *
   * Default deployments should set this comfortably ABOVE the
   * 99p expected runtime — at the CMS rate gate of ~8 req/s a
   * 1000-provider org takes ~125 seconds; a 60-minute ceiling is
   * generous without being absurd.
   */
  readonly runtimeCeilingMs: number;
}

export interface ReapStuckNpiSyncRunsResult {
  readonly reapedCount: number;
}

export interface StuckNpiSyncRunReaper {
  tick(): Promise<ReapStuckNpiSyncRunsResult>;
}

export function createStuckNpiSyncRunReaper(
  deps: ReapStuckNpiSyncRunsDeps,
  options: ReapStuckNpiSyncRunsOptions
): StuckNpiSyncRunReaper {
  const log = deps.logger.child({ component: "npi-sync-reaper" });

  return {
    async tick(): Promise<ReapStuckNpiSyncRunsResult> {
      const now = deps.clock.now();
      const cutoff = new Date(now.getTime() - options.runtimeCeilingMs);

      const reaped = await withSystemContext(
        "worker:npi-sync-reaper:sweep",
        async () =>
          await deps.client.providerSyncRun.updateMany({
            where: {
              status: "IN_PROGRESS",
              startedAt: { lt: cutoff },
            },
            data: {
              status: "FAILED",
              completedAt: now,
              errorMessage: "sync run exceeded runtime ceiling",
              errorMetadata: {
                reaper: true,
                runtimeCeilingMs: options.runtimeCeilingMs,
                reapedAt: now.toISOString(),
              },
            },
          })
      );

      if (reaped.count > 0) {
        log.warn("npi-sync-reaper.reaped", {
          event: "npi-sync-reaper.reaped",
          reapedCount: reaped.count,
          runtimeCeilingMs: options.runtimeCeilingMs,
          cutoff: cutoff.toISOString(),
        });
      }

      return Object.freeze({ reapedCount: reaped.count });
    },
  };
}
