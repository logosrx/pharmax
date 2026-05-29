// List report_schedule rows for the admin UI.
//
// Returns ALL schedules — ACTIVE / PAUSED / DISABLED — so the
// operator can see DISABLED rows (and choose to re-enable them
// via UpdateReportSchedule with `status: ACTIVE`). The list is
// ordered by `lastRunAt DESC` (matches the index
// `report_schedule_org_last_run_idx`) so freshly-failed schedules
// sort to the top.

import "server-only";

import { readInTenantContext } from "@pharmax/database";
import type {
  ReportScheduleNotifyOn,
  ReportScheduleRunStatus,
  ReportScheduleStatus,
} from "@pharmax/database";
import type { TenancyContext } from "@pharmax/tenancy";

export interface ReportScheduleListRow {
  readonly id: string;
  readonly name: string;
  readonly reportId: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly parametersTemplate: Readonly<Record<string, unknown>>;
  readonly status: ReportScheduleStatus;
  readonly lastRunAt: Date | null;
  readonly lastRunStatus: ReportScheduleRunStatus | null;
  readonly lastRunErrorCode: string | null;
  readonly nextRunAt: Date;
  readonly runCount: number;
  readonly recipients: ReadonlyArray<string>;
  readonly notifyOn: ReportScheduleNotifyOn;
  readonly createdByDisplayName: string | null;
}

const SELECT_FIELDS = {
  id: true,
  name: true,
  reportId: true,
  cronExpression: true,
  timezone: true,
  parametersTemplate: true,
  status: true,
  lastRunAt: true,
  lastRunStatus: true,
  lastRunErrorCode: true,
  nextRunAt: true,
  runCount: true,
  recipients: true,
  notifyOn: true,
  createdByUser: { select: { displayName: true } },
} as const;

type RawRow = {
  id: string;
  name: string;
  reportId: string;
  cronExpression: string;
  timezone: string;
  parametersTemplate: unknown;
  status: ReportScheduleStatus;
  lastRunAt: Date | null;
  lastRunStatus: ReportScheduleRunStatus | null;
  lastRunErrorCode: string | null;
  nextRunAt: Date;
  runCount: number;
  recipients: string[];
  notifyOn: ReportScheduleNotifyOn;
  createdByUser: { displayName: string } | null;
};

function freezeRow(row: RawRow): ReportScheduleListRow {
  return Object.freeze({
    id: row.id,
    name: row.name,
    reportId: row.reportId,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    parametersTemplate: (row.parametersTemplate ?? {}) as Readonly<Record<string, unknown>>,
    status: row.status,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    lastRunErrorCode: row.lastRunErrorCode,
    nextRunAt: row.nextRunAt,
    runCount: row.runCount,
    recipients: Object.freeze([...row.recipients]),
    notifyOn: row.notifyOn,
    createdByDisplayName: row.createdByUser?.displayName ?? null,
  });
}

export async function listReportSchedules(input: {
  readonly tenancy: TenancyContext;
}): Promise<ReadonlyArray<ReportScheduleListRow>> {
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.reportSchedule.findMany({
      orderBy: [{ lastRunAt: "desc" }, { createdAt: "desc" }],
      select: SELECT_FIELDS,
    });
    return rows.map((row) => freezeRow(row as RawRow));
  });
}

export async function getReportScheduleById(input: {
  readonly tenancy: TenancyContext;
  readonly reportScheduleId: string;
}): Promise<ReportScheduleListRow | null> {
  return readInTenantContext(input.tenancy, async (tx) => {
    const row = await tx.reportSchedule.findFirst({
      where: { id: input.reportScheduleId },
      select: SELECT_FIELDS,
    });
    if (row === null) return null;
    return freezeRow(row as RawRow);
  });
}
