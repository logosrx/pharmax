// Barcode scan failure rate — per-reason counts and a failure rate
// for fill-completion scan validation, over a date range.
//
// Serves the product requirement (rules: "scan failure rates",
// "Barcode scanner validation"). A scan failure means the vial,
// lot, or NDC a tech physically scanned did not match what the
// order expected. That is the control standing between a
// mis-picked drug and a shipped order, so the RATE is the number
// that matters: a rising rate points at a mislabelled shelf, a
// worn barcode, a printer drifting out of spec, or a tech working
// around the scanner.
//
// Where the data comes from
// -------------------------
// Scan validation is pure (`@pharmax/scan`) and persists nothing on
// its own. `CompleteFill` throws a `ConflictError` carrying the
// validation's own code, and the command bus records that on
// `command_log.error_code` before rethrowing. So every scan failure
// is already on disk as a FAILED `CompleteFill` row — no new table,
// and the history predates this report.
//
// Matched on the `FILL_SCAN_` prefix rather than an enumerated list
// of the ten current codes: `@pharmax/scan` owns that vocabulary and
// adds to it, and a report that silently omits a newly-added failure
// mode is worse than one that shows an unfamiliar code.
//
// Tenancy: ORG-SCOPED ONLY, and it refuses to run for a
// clinic-scoped operator. This is a real constraint, not an
// oversight. The bus sets `targetOrderId` on the committed-refusal
// path but NOT on the thrown-error path, and scan failures throw —
// so these rows carry no order FK and therefore no clinic linkage.
// Rather than silently widening a clinic-scoped operator's view to
// the whole organization, the report refuses. Fixing the bus to
// carry `targetOrderId` through the throw path would unlock clinic
// scoping, and would not backfill existing rows.
//
// The scope is arguably right anyway: scanning happens on the
// pharmacy floor, by pharmacy staff, against pharmacy stock. It is
// a site-level quality metric, not a clinic-level one.
//
// PHI invariant: queries only `commandName`, `status`, `errorCode`,
// `startedAt`, and `actorUserId`. No patient columns, and no
// `requestPayload` read — that column is redacted but is a payload
// snapshot, so it stays out of a report row on principle.

import { CommandStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

/** Every fill-completion scan validation code shares this prefix. */
const SCAN_FAILURE_CODE_PREFIX = "FILL_SCAN_";

/** The only command that runs scan validation today. */
const SCANNING_COMMAND = "CompleteFill";

export const SCAN_FAILURE_REPORT_CLINIC_SCOPE_UNSUPPORTED =
  "SCAN_FAILURE_REPORT_CLINIC_SCOPE_UNSUPPORTED";

export interface ScanFailureRateRow {
  /** e.g. `FILL_SCAN_NDC_MISMATCH`. */
  readonly failureCode: string;
  readonly failureCount: number;
  /** Share of all scan failures, in basis points. */
  readonly shareOfFailuresBps: number;
}

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type ScanFailureRateParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

export const scanFailureRateReport: ReportDefinition<typeof paramsSchema, ScanFailureRateRow> = {
  id: "scan-failure-rate",
  version: 1,
  title: "Barcode scan failure rate",
  description:
    "Fill-completion scan validation failures by reason code within a date range, with each reason's share of failures and the overall failure rate against all fill attempts. A rising rate points at a mislabelled shelf, a worn barcode, or a printer drifting out of spec.",
  parametersSchema: paramsSchema,
  parameterFields: [...dateRangeFields()],

  async run(ctx, params): Promise<ReportResult<ScanFailureRateRow>> {
    if (ctx.clinicId !== undefined) {
      throw new errors.ValidationError({
        code: SCAN_FAILURE_REPORT_CLINIC_SCOPE_UNSUPPORTED,
        message:
          "Scan failure rate cannot be scoped to a clinic: failed fill commands carry no order linkage, so the rows cannot be attributed to one. Run it at organization scope.",
      });
    }

    const window: DateRangeParams = { from: params.from, to: params.to };
    const startedAt = { gte: window.from, lte: window.to };

    // Both queries ride the `(organizationId, commandName, startedAt)`
    // index.
    const [groups, attemptCount] = await Promise.all([
      ctx.client.commandLog.groupBy({
        by: ["errorCode"],
        where: {
          organizationId: ctx.organizationId,
          commandName: SCANNING_COMMAND,
          status: CommandStatus.FAILED,
          errorCode: { startsWith: SCAN_FAILURE_CODE_PREFIX },
          startedAt,
        },
        _count: { _all: true },
      }),
      // Denominator is every fill attempt in the window, not just the
      // failed ones — "8 NDC mismatches" reads very differently
      // against 40 fills than against 4,000.
      ctx.client.commandLog.count({
        where: {
          organizationId: ctx.organizationId,
          commandName: SCANNING_COMMAND,
          startedAt,
        },
      }),
    ]);

    const totalFailures = groups.reduce((n, g) => n + g._count._all, 0);

    const rows: ScanFailureRateRow[] = groups
      // `errorCode` is nullable on the model; the `startsWith` filter
      // already excludes nulls, so this narrows the type rather than
      // changing the result.
      .filter((g): g is typeof g & { errorCode: string } => g.errorCode !== null)
      .map((g) =>
        Object.freeze({
          failureCode: g.errorCode,
          failureCount: g._count._all,
          shareOfFailuresBps: rateBps(g._count._all, totalFailures),
        })
      )
      // Worst offender first; code as the tiebreak so equal counts
      // produce a stable CSV.
      .sort((a, b) =>
        b.failureCount !== a.failureCount
          ? b.failureCount - a.failureCount
          : a.failureCode.localeCompare(b.failureCode)
      );

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalScanFailures: totalFailures,
        totalFillAttempts: attemptCount,
        scanFailureRateBps: rateBps(totalFailures, attemptCount),
        distinctFailureCodes: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
