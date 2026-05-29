// RunReport — single entry point for executing a registered
// report against the operator's tenant.
//
// Why a bus command (vs. a bare function call from a route):
//   - SOC 2 wants "who ran what report when with which filters"
//     as a tamper-evident audit row. The standard bus pipeline
//     gives us that via `command_log` + `audit_log` + the chain
//     writer for free.
//   - Same command serves operator-initiated runs (POST from the
//     reports page) AND future scheduled runs (a worker tick
//     dispatches the same command under a per-org service user).
//   - Dynamic parameter validation: the input schema at the bus
//     level is `{ reportId, parameters: unknown }`. The handler
//     resolves the report definition from `REPORT_REGISTRY`,
//     re-validates `parameters` against the report's own Zod
//     schema, then runs. A bad reportId or bad parameters
//     surface as typed errors at the bus boundary.
//
// What's persisted:
//   - One `report_run` row with the resolved parameters
//     (post-Zod-parse), the window the report ran over, the
//     aggregates, and the row count.
//   - One `audit_log` row (action: `report.run`) with the same
//     metadata.
//   - One `event_outbox` row (`reporting.run.completed.v1`) for
//     downstream consumers (future scheduled-run reconciliation,
//     email delivery, etc.).
//
// What's NOT persisted:
//   - The full result row set. Downloads re-run against the same
//     parameters + window — historical date-range reports
//     produce stable output, and the row count + aggregates on
//     the report_run row are the citation. A future slice may
//     add row-set persistence for non-deterministic reports
//     (e.g. when reporting moves to a snapshot replica).
//
// PHI invariant:
//   - The current report registry surfaces only non-PHI columns
//     (status counts, SLA breach counts by stage). Future reports
//     that decrypt PHI for display MUST add a per-row audit (same
//     pattern as ViewPatient — that's a future per-report
//     decision).
//   - `parameters` in `command_log.requestPayload` is NOT redacted
//     because today's report params are non-PHI (date ranges,
//     status enums, clinic ids). When a future report adds a
//     PHI-bearing parameter, this command's `redactFields` MUST
//     be updated.

import { createHash } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors, logger as loggerNs } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { getReportRunArchive } from "../archive/configure.js";
import { toCsv } from "../csv.js";
import { REPORT_REGISTRY, type ReportDefinitionAny } from "../report-registry.js";
import type { ReportResult } from "../types.js";

export const REPORT_NOT_FOUND = "REPORT_NOT_FOUND";
export const REPORT_PARAMETERS_INVALID = "REPORT_PARAMETERS_INVALID";

const inputSchema = z
  .object({
    reportId: z.string().min(1).max(128),
    /**
     * Parameters validated dynamically by the report's own Zod
     * schema inside the handler. We accept `unknown` here so the
     * bus-level Zod parse is shallow; the deep parse runs after
     * we know which report we're running.
     */
    parameters: z.unknown(),
    /**
     * Optional schedule id. When the worker tick fires
     * `RunReport` from a `report_schedule` row, it passes the
     * schedule's id here so the persisted `report_run` row
     * carries it on `runViaScheduleId`. Downstream consumers
     * (notably the `reporting.run.completed.v1` notification
     * handler) use this to distinguish "operator clicked Run +
     * Download" (no schedule id) from "cron tick fired"
     * (schedule id present → fan out to recipients).
     *
     * Validated as UUID at the bus boundary; the column on
     * `report_run` is plain TEXT so we don't enforce uuid in the
     * DB, but every callsite that produces this value DOES use a
     * UUID, so the bus-level shape stays narrow.
     */
    scheduleId: z.uuid().optional(),
    /**
     * When true, the handler serializes the row set to CSV and
     * uploads it via the configured `ReportRunArchivePort`. The
     * resulting `{bucket, key, sha256Hex, sizeBytes}` lands on
     * the `report_run` row.
     *
     * Defaults to false — operator-initiated runs stream their
     * CSV in-browser and don't need a second copy in S3. The
     * worker tick passes `true` for scheduled runs so the
     * "View past runs" UI + email download link have something
     * to point at.
     *
     * If `true` AND no archive is configured at runtime, the
     * handler logs a warn + persists the report_run row with
     * NULL archive columns (no hard failure — dev environments
     * without S3 still work).
     */
    persistCsv: z.boolean().optional(),
  })
  .strict();

export type RunReportInput = z.infer<typeof inputSchema>;

export interface RunReportOutput<TRow extends object = Record<string, unknown>> {
  readonly reportRunId: string;
  readonly reportId: string;
  readonly reportVersion: number;
  readonly windowFrom: string; // ISO
  readonly windowTo: string; // ISO
  readonly generatedAt: string; // ISO
  readonly rowCount: number;
  readonly aggregates: Readonly<Record<string, number>>;
  /**
   * The row set. NOT persisted to `report_run`; the caller
   * uses this for immediate CSV streaming. Future cached-result
   * slices may add an optional `reportRunId` re-fetch path.
   */
  readonly rows: ReadonlyArray<TRow>;
  /**
   * Set when `persistCsv: true` was supplied AND the archive
   * adapter accepted the upload. The download path resolves
   * `{bucket, key}` from the `report_run` row and re-checks
   * `sha256Hex` after the GET.
   */
  readonly archive: {
    readonly bucket: string;
    readonly key: string;
    readonly sha256Hex: string;
    readonly sizeBytes: number;
  } | null;
}

/**
 * Helper for the `persistCsv` path. Pulled out of the handler
 * body so the main `handle()` reads linearly without the
 * try/catch + archive-resolution noise.
 *
 * Returns:
 *   - `null` when the caller asked us NOT to persist, OR when no
 *     archive is configured (dev env). Logs the skip in the
 *     latter case.
 *   - the archive descriptor on success.
 *
 * Throws `REPORT_RUN_ARCHIVE_PUT_FAILED` wrapping the underlying
 * cause when the port's `.put` throws. The tx around it rolls
 * back the bus pipeline.
 */
async function maybePersistCsv(input: {
  readonly persistCsv: boolean;
  readonly reportRunId: string | undefined;
  readonly organizationId: string;
  readonly reportId: string;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly persistedAt: Date;
}): Promise<RunReportOutput["archive"]> {
  if (!input.persistCsv) return null;
  const archive = getReportRunArchive();
  if (archive === null) {
    loggerNs.noopLogger.warn("run-report.archive_skipped_unconfigured", {
      reportId: input.reportId,
      reason: "no ReportRunArchivePort configured at boot",
    });
    return null;
  }
  if (input.reportRunId === undefined) {
    // Defensive: persistCsv was true but the caller didn't
    // pre-allocate an id. The current handler always does; this
    // is a programming-error guard.
    throw new errors.InternalError({
      code: "REPORT_RUN_ARCHIVE_PUT_FAILED",
      message: "persistCsv=true but no reportRunId was pre-allocated.",
      metadata: { reportId: input.reportId },
    });
  }
  const csvBytes = new TextEncoder().encode(toCsv(input.rows));
  const sha256Hex = createHash("sha256").update(csvBytes).digest("hex");
  try {
    const put = await archive.put({
      organizationId: input.organizationId,
      reportRunId: input.reportRunId,
      csv: csvBytes,
      sha256Hex,
      contentType: "text/csv",
      persistedAt: input.persistedAt,
    });
    return Object.freeze({
      bucket: put.bucket,
      key: put.key,
      sha256Hex,
      sizeBytes: put.sizeBytes,
    });
  } catch (cause) {
    throw new errors.InternalError({
      code: "REPORT_RUN_ARCHIVE_PUT_FAILED",
      message: "Failed to persist CSV to ReportRunArchivePort.",
      metadata: { reportId: input.reportId, reportRunId: input.reportRunId },
      cause,
    });
  }
}

export const RunReport: Command<RunReportInput, RunReportOutput> = {
  name: "RunReport",
  inputSchema,
  permission: PERMISSIONS.REPORTS_RUN,
  // Empty for now — see header note: today's reports take non-PHI
  // params (date ranges, status enums). When a PHI-bearing param
  // lands, this list MUST be updated.
  redactFields: [],

  async handle({ input, ctx, tx, commandLogId, clock }): Promise<HandlerResult<RunReportOutput>> {
    // 1. Resolve the report definition by id.
    const definition = REPORT_REGISTRY[input.reportId] as ReportDefinitionAny | undefined;
    if (definition === undefined) {
      throw new errors.NotFoundError({
        code: REPORT_NOT_FOUND,
        message: `No report registered with id "${input.reportId}".`,
        metadata: {
          reportId: input.reportId,
          knownReportIds: Object.keys(REPORT_REGISTRY).sort(),
        },
      });
    }

    // 2. Dynamic Zod parse against the report's own schema.
    //    A failure here surfaces as a typed validation error
    //    rather than a generic "bad parameters" — the UI can
    //    render per-field issues.
    const parsedParams = definition.parametersSchema.safeParse(input.parameters);
    if (!parsedParams.success) {
      throw new errors.ValidationError({
        code: REPORT_PARAMETERS_INVALID,
        message: `Parameters did not pass the report's parameter schema for "${input.reportId}".`,
        metadata: {
          reportId: input.reportId,
          issues: parsedParams.error.flatten(),
        },
      });
    }

    // 3. Run the report. The report receives a ReportRunContext
    //    with the active tx as the Prisma client — keeps reads
    //    inside the same connection as our writes below, so the
    //    audit row + report run row are atomic with the read.
    const now = clock.now();
    const result: ReportResult<Record<string, unknown>> = await definition.run(
      {
        client: tx as unknown as Parameters<typeof definition.run>[0]["client"],
        organizationId: ctx.organizationId,
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
        asOf: now,
      },
      parsedParams.data
    );

    // 4a. CSV archive. When the operator asked us to persist, we
    //     pre-allocate the report_run id, serialize the row set
    //     to CSV, hash it, then upload via the configured port.
    //     The pre-allocated id is embedded in the archive's key
    //     path so a `report_run.id` → `csvObjectKey` join is
    //     deterministic (and a future operator can audit
    //     "everything we wrote for run X" with one prefix scan).
    //
    //     We perform the put BEFORE the report_run insert so a
    //     transport failure rolls back the whole tx (no orphaned
    //     row pointing at a key that doesn't exist). The cost is
    //     that a successful put followed by a tx rollback leaves
    //     an orphan OBJECT in S3, which is the cheaper side of
    //     the asymmetry (object-level lifecycle rules can reap
    //     orphans; a row pointing at nothing is harder to
    //     reconcile).
    //
    //     Missing archive (dev env) → soft skip + log; the
    //     report_run row persists with NULL archive columns.
    const preallocatedReportRunId = input.persistCsv === true ? crypto.randomUUID() : undefined;
    const archiveResult = await maybePersistCsv({
      persistCsv: input.persistCsv === true,
      reportRunId: preallocatedReportRunId,
      organizationId: ctx.organizationId,
      reportId: definition.id,
      rows: result.rows,
      persistedAt: now,
    });

    // 4b. Persist the report_run row.
    const persisted = await tx.reportRun.create({
      data: {
        ...(preallocatedReportRunId !== undefined ? { id: preallocatedReportRunId } : {}),
        organizationId: ctx.organizationId,
        reportId: definition.id,
        reportVersion: definition.version,
        parameters: parsedParams.data as object,
        aggregates: result.aggregates as object,
        rowCount: result.rows.length,
        windowFrom: result.window.from,
        windowTo: result.window.to,
        generatedAt: result.generatedAt,
        runByUserId: ctx.actor.userId,
        commandLogId,
        ...(input.scheduleId !== undefined ? { runViaScheduleId: input.scheduleId } : {}),
        ...(archiveResult !== null
          ? {
              csvObjectBucket: archiveResult.bucket,
              csvObjectKey: archiveResult.key,
              csvSizeBytes: archiveResult.sizeBytes,
              csvSha256Hex: archiveResult.sha256Hex,
              csvPersistedAt: now,
            }
          : {}),
      },
      select: { id: true },
    });

    return {
      output: Object.freeze({
        reportRunId: persisted.id,
        reportId: definition.id,
        reportVersion: definition.version,
        windowFrom: result.window.from.toISOString(),
        windowTo: result.window.to.toISOString(),
        generatedAt: result.generatedAt.toISOString(),
        rowCount: result.rows.length,
        aggregates: result.aggregates,
        rows: result.rows,
        archive:
          archiveResult === null
            ? null
            : Object.freeze({
                bucket: archiveResult.bucket,
                key: archiveResult.key,
                sha256Hex: archiveResult.sha256Hex,
                sizeBytes: archiveResult.sizeBytes,
              }),
      }),
      audit: {
        action: "report.run",
        resourceType: "ReportRun",
        resourceId: persisted.id,
        metadata: {
          reportId: definition.id,
          reportVersion: definition.version,
          rowCount: result.rows.length,
          aggregates: result.aggregates,
          windowFromIso: result.window.from.toISOString(),
          windowToIso: result.window.to.toISOString(),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "reporting.run.completed.v1",
          aggregateType: "ReportRun",
          aggregateId: persisted.id,
          payload: {
            organizationId: ctx.organizationId,
            reportRunId: persisted.id,
            reportId: definition.id,
            reportVersion: definition.version,
            rowCount: result.rows.length,
            aggregates: result.aggregates,
            windowFrom: result.window.from.toISOString(),
            windowTo: result.window.to.toISOString(),
            generatedAt: result.generatedAt.toISOString(),
            runByUserId: ctx.actor.userId,
            // Thread the schedule id through to the outbox payload
            // so the notification handler can distinguish "operator
            // clicked Run + Download" from "cron tick fired"
            // without an extra DB lookup.
            runViaScheduleId: input.scheduleId ?? null,
          },
        },
      ],
    };
  },
};
