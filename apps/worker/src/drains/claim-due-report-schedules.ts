// Cross-tenant claim of report_schedule rows due for execution.
//
// Selection rules (all AND):
//   - `status = 'ACTIVE'` (PAUSED and DISABLED rows are excluded
//     by the partial index `report_schedule_due_idx`)
//   - `nextRunAt <= NOW()` — the schedule is due
//
// Uses `FOR UPDATE SKIP LOCKED` so multiple worker replicas don't
// double-dispatch the same schedule. The worker tick advances
// `nextRunAt` to the next-fire (computed by cron-parser) inside
// the SAME tx that does the dispatch, so a crashed worker that
// holds a lock briefly will roll back and another worker picks
// the row up on its next tick.
//
// Cross-tenant scope: the worker drain runs in system context,
// reads across orgs in one SQL pass, then the dispatcher loops
// per-row to enter tenancy + call `RunReport` through the bus.
// Legitimate system-context bridge (see eslint Override 3b).

import type { PrismaClient } from "@pharmax/database";

export interface DueReportScheduleRow {
  readonly id: string;
  readonly organizationId: string;
  readonly reportId: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly parametersTemplate: Readonly<Record<string, unknown>>;
  readonly nextRunAt: Date;
}

export interface ClaimDueReportSchedulesOptions {
  readonly batchSize: number;
}

export type ReportScheduleClaimClient = Pick<PrismaClient, "$queryRaw">;

interface RawRow {
  id: string;
  organizationId: string;
  reportId: string;
  cronExpression: string;
  timezone: string;
  parametersTemplate: unknown;
  nextRunAt: Date;
}

export async function claimDueReportSchedules(
  client: ReportScheduleClaimClient,
  options: ClaimDueReportSchedulesOptions
): Promise<DueReportScheduleRow[]> {
  const { batchSize } = options;

  // FOR UPDATE SKIP LOCKED: two workers ticking simultaneously
  // claim disjoint subsets. The advance-nextRunAt update inside
  // the dispatcher's tx releases the lock on commit.
  const rows = await client.$queryRaw<RawRow[]>`
    SELECT
      id,
      "organizationId",
      "reportId",
      "cronExpression",
      "timezone",
      "parametersTemplate",
      "nextRunAt"
    FROM "report_schedule"
    WHERE "status" = 'ACTIVE'
      AND "nextRunAt" <= NOW()
    ORDER BY "nextRunAt" ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `;

  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      organizationId: row.organizationId,
      reportId: row.reportId,
      cronExpression: row.cronExpression,
      timezone: row.timezone,
      parametersTemplate: (row.parametersTemplate ?? {}) as Readonly<Record<string, unknown>>,
      nextRunAt: row.nextRunAt,
    })
  );
}
