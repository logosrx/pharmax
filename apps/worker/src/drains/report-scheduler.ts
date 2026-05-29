// Report scheduler — per-tick logic.
//
// Each tick:
//   1. Claim up to `batchSize` due report_schedule rows in system
//      context (cross-tenant). Rows are SELECT FOR UPDATE SKIP
//      LOCKED so concurrent workers don't double-dispatch.
//   2. For each row, enter the schedule's tenancy under a per-org
//      `reports-scheduler@<org-slug>.test` service user, dispatch
//      RunReport with the placeholder-resolved parameters, then
//      update the row with the new `nextRunAt` + `lastRun*` fields.
//   3. Per-schedule failures are isolated. A missing service user
//      surfaces as SKIPPED (config error); a RunReport throw
//      surfaces as FAILED (runtime fault). Both paths advance
//      `nextRunAt` so a sticky failure doesn't infinite-loop.
//
// Why not a bus command for the per-schedule work: the dispatcher
// here is purely worker infrastructure — it doesn't change any
// per-schedule state until AFTER RunReport's tx commits. Using a
// bus command would add an unnecessary outer tx layer; the
// inner RunReport already writes audit/outbox.

import { executeCommand } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { computeNextRun, resolveTemplate, RunReport } from "@pharmax/reporting";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

import {
  claimDueReportSchedules,
  type DueReportScheduleRow,
  type ReportScheduleClaimClient,
} from "./claim-due-report-schedules.js";

type Logger = loggerContract.Logger;

export interface ReportSchedulerDeps {
  readonly client: PrismaClient & ReportScheduleClaimClient;
  readonly logger: Logger;
  /**
   * Local-part of the per-org service-user email used to enter
   * tenancy. Defaults to `reports-scheduler`; the full email
   * is `${actorEmailLocalPart}@${org.slug}.test` to match the
   * seed convention.
   */
  readonly actorEmailLocalPart?: string;
}

export interface ReportSchedulerOptions {
  readonly batchSize: number;
}

export interface ReportSchedulerTickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

export function createReportScheduler(
  deps: ReportSchedulerDeps,
  options: ReportSchedulerOptions
): { tick: () => Promise<ReportSchedulerTickResult> } {
  const log = deps.logger.child({ component: "report-scheduler" });
  const actorEmailLocalPart = deps.actorEmailLocalPart ?? "reports-scheduler";

  return {
    async tick(): Promise<ReportSchedulerTickResult> {
      // 1. Claim due rows in system context.
      const dueRows = await withSystemContext(
        "worker:report-scheduler:claim",
        async () => await claimDueReportSchedules(deps.client, { batchSize: options.batchSize })
      );

      if (dueRows.length === 0) {
        return Object.freeze({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
      }
      log.info("report-scheduler.claimed", { claimed: dueRows.length });

      let succeeded = 0;
      let failed = 0;
      let skipped = 0;

      for (const row of dueRows) {
        const outcome = await processSchedule({ ...deps, actorEmailLocalPart, log }, row);
        if (outcome === "SUCCEEDED") succeeded += 1;
        else if (outcome === "FAILED") failed += 1;
        else skipped += 1;
      }

      return Object.freeze({
        claimed: dueRows.length,
        succeeded,
        failed,
        skipped,
      });
    },
  };
}

type Outcome = "SUCCEEDED" | "FAILED" | "SKIPPED";

async function processSchedule(
  deps: {
    readonly client: PrismaClient;
    readonly log: Logger;
    readonly actorEmailLocalPart: string;
  },
  row: DueReportScheduleRow
): Promise<Outcome> {
  const now = new Date();

  // Resolve org slug + per-org service user in system context.
  // A missing user is a config error (run the seed); we mark
  // SKIPPED + advance nextRunAt so the schedule doesn't infinite-
  // loop while the admin fixes the seed.
  const resolved = await withSystemContext("worker:report-scheduler:resolve-actor", async () => {
    const org = await deps.client.organization.findUnique({
      where: { id: row.organizationId },
      select: { slug: true },
    });
    if (org === null) return null;
    const actor = await deps.client.user.findFirst({
      where: {
        organizationId: row.organizationId,
        email: `${deps.actorEmailLocalPart}@${org.slug}.test`,
      },
      select: { id: true },
    });
    return actor === null ? null : { actorUserId: actor.id };
  });

  if (resolved === null) {
    deps.log.warn("report-scheduler.skipped_no_actor", {
      event: "report-scheduler.skipped_no_actor",
      reportScheduleId: row.id,
      organizationId: row.organizationId,
      reportId: row.reportId,
    });
    await advanceNextRun(deps.client, row, now, "SKIPPED", null, "ACTOR_NOT_FOUND");
    return "SKIPPED";
  }

  // Resolve placeholders + dispatch RunReport in per-org tenancy.
  const resolvedParams = resolveTemplate({ template: row.parametersTemplate, now });
  const tenancy = buildTenancyContext({
    organizationId: row.organizationId,
    actor: { userId: resolved.actorUserId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(
        RunReport,
        {
          reportId: row.reportId,
          parameters: resolvedParams,
          // Thread the schedule id so it lands on
          // `report_run.runViaScheduleId` AND on the
          // `reporting.run.completed.v1` outbox payload. The
          // notification handler keys on it to distinguish
          // operator-initiated runs (skip) from cron-fired runs
          // (fan out to recipients).
          scheduleId: row.id,
          // Scheduled runs ALWAYS persist their CSV — that's the
          // SOC-2 evidence + the "download from email link" the
          // notification handler relies on. Operator-initiated
          // runs leave this unset (they get the CSV in-browser).
          persistCsv: true,
        },
        {
          // Minute-bucketed idempotency key per (schedule, minute)
          // — re-ticks within the same minute are a no-op via the
          // bus's idempotency cache. The advance to nextRunAt
          // ensures this won't naturally recur within a minute
          // anyway; the key is belt + suspenders.
          idempotencyKey: `schedule:${row.id}:${Math.floor(now.getTime() / 60_000)}`,
        }
      )
    );
    await advanceNextRun(deps.client, row, now, "SUCCEEDED", out.reportRunId, null);
    deps.log.info("report-scheduler.dispatched", {
      event: "report-scheduler.dispatched",
      reportScheduleId: row.id,
      organizationId: row.organizationId,
      reportId: row.reportId,
      reportRunId: out.reportRunId,
      rowCount: out.rowCount,
    });
    return "SUCCEEDED";
  } catch (cause) {
    const code =
      cause instanceof errors.PharmaxError ? cause.code : "REPORT_SCHEDULER_DISPATCH_FAILED";
    deps.log.error("report-scheduler.dispatch_failed", {
      event: "report-scheduler.dispatch_failed",
      reportScheduleId: row.id,
      organizationId: row.organizationId,
      reportId: row.reportId,
      code,
      error: cause,
    });
    await advanceNextRun(deps.client, row, now, "FAILED", null, code);
    return "FAILED";
  }
}

/**
 * Advance the schedule's `nextRunAt` + record the run outcome.
 * Runs in system context (cross-tenant; we may be processing N
 * different orgs in one tick and don't want to bounce in/out of
 * tenancy for each row). The schedule row is already locked by
 * the tick's claim — the update is on the row we hold.
 */
async function advanceNextRun(
  client: PrismaClient,
  row: DueReportScheduleRow,
  now: Date,
  outcome: Outcome,
  reportRunId: string | null,
  errorCode: string | null
): Promise<void> {
  const newNext = computeNextRun({
    expression: row.cronExpression,
    timezone: row.timezone,
    from: now,
  });
  await withSystemContext("worker:report-scheduler:advance-next-run", async () => {
    await client.reportSchedule.update({
      where: { id: row.id },
      data: {
        nextRunAt: newNext,
        lastRunAt: now,
        lastRunStatus: outcome,
        lastRunReportRunId: reportRunId,
        lastRunErrorCode: errorCode,
        runCount: { increment: 1 },
      },
    });
  });
}
