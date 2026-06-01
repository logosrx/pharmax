// List `report_run` rows for the operator console.
//
// Two query shapes:
//   - listReportRuns({ tenancy, limit }) — org-wide page;
//     ordered by `generatedAt DESC`. Matches the index
//     `report_run_org_generated_idx`.
//   - listReportRunsBySchedule({ tenancy, scheduleId, limit }) —
//     per-schedule page used by the schedule edit / detail UI.
//     Filters on `runViaScheduleId = $1`.
//
// Both surfaces project `csvObjectKey` so the row's "Download
// CSV" button can be conditionally rendered (NULL key → "not
// archived" badge).
//
// PHI: no PHI in `report_run`. We project run metadata + the
// `runByUser` display name (operator metadata).

import "server-only";

import { readInTenantContext } from "@pharmax/database";
import { type TenancyContext } from "@pharmax/tenancy";

export interface ReportRunListRow {
  readonly id: string;
  readonly reportId: string;
  readonly reportVersion: number;
  readonly rowCount: number;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly generatedAt: Date;
  readonly runByDisplayName: string | null;
  readonly runViaScheduleId: string | null;
  readonly hasCsv: boolean;
  readonly csvSizeBytes: number | null;
  readonly aggregates: Readonly<Record<string, number>>;
}

const SELECT = {
  id: true,
  reportId: true,
  reportVersion: true,
  rowCount: true,
  windowFrom: true,
  windowTo: true,
  generatedAt: true,
  aggregates: true,
  runByUser: { select: { displayName: true } },
  runViaScheduleId: true,
  csvObjectKey: true,
  csvSizeBytes: true,
} as const;

type Raw = {
  id: string;
  reportId: string;
  reportVersion: number;
  rowCount: number;
  windowFrom: Date;
  windowTo: Date;
  generatedAt: Date;
  aggregates: unknown;
  runByUser: { displayName: string } | null;
  runViaScheduleId: string | null;
  csvObjectKey: string | null;
  csvSizeBytes: number | null;
};

function freezeRow(row: Raw): ReportRunListRow {
  return Object.freeze({
    id: row.id,
    reportId: row.reportId,
    reportVersion: row.reportVersion,
    rowCount: row.rowCount,
    windowFrom: row.windowFrom,
    windowTo: row.windowTo,
    generatedAt: row.generatedAt,
    runByDisplayName: row.runByUser?.displayName ?? null,
    runViaScheduleId: row.runViaScheduleId,
    hasCsv: row.csvObjectKey !== null,
    csvSizeBytes: row.csvSizeBytes,
    aggregates: (row.aggregates ?? {}) as Readonly<Record<string, number>>,
  });
}

export async function listReportRuns(input: {
  readonly tenancy: TenancyContext;
  readonly limit?: number;
}): Promise<ReadonlyArray<ReportRunListRow>> {
  const limit = input.limit ?? 100;
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.reportRun.findMany({
      orderBy: { generatedAt: "desc" },
      take: limit,
      select: SELECT,
    });
    return rows.map((r) => freezeRow(r as Raw));
  });
}

export async function listReportRunsBySchedule(input: {
  readonly tenancy: TenancyContext;
  readonly scheduleId: string;
  readonly limit?: number;
}): Promise<ReadonlyArray<ReportRunListRow>> {
  const limit = input.limit ?? 100;
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.reportRun.findMany({
      where: { runViaScheduleId: input.scheduleId },
      orderBy: { generatedAt: "desc" },
      take: limit,
      select: SELECT,
    });
    return rows.map((r) => freezeRow(r as Raw));
  });
}

export interface ReportRunDownloadDescriptor {
  readonly id: string;
  readonly reportId: string;
  readonly organizationId: string;
  readonly csvObjectBucket: string;
  readonly csvObjectKey: string;
  readonly csvSizeBytes: number;
  readonly csvSha256Hex: string;
  readonly generatedAt: Date;
  readonly windowFrom: Date;
  readonly windowTo: Date;
}

/**
 * Resolve a report-run row to the descriptor the download route
 * needs. Returns `null` when the row doesn't exist in the active
 * tenancy OR when no CSV has been persisted for it.
 */
export async function getReportRunForDownload(input: {
  readonly tenancy: TenancyContext;
  readonly reportRunId: string;
}): Promise<ReportRunDownloadDescriptor | null> {
  return readInTenantContext(input.tenancy, async (tx) => {
    const row = await tx.reportRun.findFirst({
      where: { id: input.reportRunId },
      select: {
        id: true,
        reportId: true,
        organizationId: true,
        csvObjectBucket: true,
        csvObjectKey: true,
        csvSizeBytes: true,
        csvSha256Hex: true,
        generatedAt: true,
        windowFrom: true,
        windowTo: true,
      },
    });
    if (row === null) return null;
    if (
      row.csvObjectBucket === null ||
      row.csvObjectKey === null ||
      row.csvSizeBytes === null ||
      row.csvSha256Hex === null
    ) {
      return null;
    }
    return Object.freeze({
      id: row.id,
      reportId: row.reportId,
      organizationId: row.organizationId,
      csvObjectBucket: row.csvObjectBucket,
      csvObjectKey: row.csvObjectKey,
      csvSizeBytes: row.csvSizeBytes,
      csvSha256Hex: row.csvSha256Hex,
      generatedAt: row.generatedAt,
      windowFrom: row.windowFrom,
      windowTo: row.windowTo,
    });
  });
}
