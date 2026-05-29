// reporting.run.completed.v1 — a registered report finished executing
// and the `report_run` ledger row was persisted.
//
// Producer: `RunReport` (`@pharmax/reporting`).
//   Dispatched from `/api/ops/reports/[reportId]/run` (operator-
//   initiated download) and, in the future, from a scheduled-run
//   worker tick under a per-org service user. Both call paths share
//   the same command, so this event is the SINGLE downstream signal
//   regardless of who triggered the run.
//
// Consumers (current):
//   - none yet. Today the event is fan-out optionality + a tamper-
//     evident downstream record paired with the `report_run` row.
//
// Consumers (future):
//   - Scheduled-run worker reconciles "this schedule fired, and a
//     report_run with `runViaScheduleId = ...` landed within the
//     SLA window" — missed schedules surface from the OUTBOX log
//     even if the `report_run` insert failed.
//   - Email/notification adapter mails CSVs to subscribers on
//     scheduled completions.
//   - BI ingestion pipeline tails this stream to project a
//     "reports ran per clinic per week" dashboard tile.
//
// PHI invariant: `aggregates` is a `Record<string, number>` —
// scalar counters / sums only. Today's report registry never
// surfaces PHI in aggregates (status counts, SLA breach counts).
// If a future report adds a PHI-bearing aggregate, the schema MUST
// switch off `aggregates: z.record(z.string(), z.number())` and
// split out a per-aggregate type, AND the `RunReport.redactFields`
// list MUST gain the offending parameter name in the same PR —
// see the PHI note on `@pharmax/reporting/commands/run-report.ts`.
//
// What's NOT in the payload:
//   - The row set itself. The runner returns rows to the caller for
//     immediate CSV streaming; persisting the rows AGAIN on the
//     outbox would (a) duplicate the result set, (b) make this
//     event payload arbitrarily large, and (c) tempt consumers to
//     bypass the access-controlled `report_run` row. Consumers that
//     need the data re-run the report (deterministic for the
//     date-range reports we ship today) or query the `report_run`
//     row by id (which goes through tenant-scoped RLS).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    /** `report_run.id` — the ledger row for this execution. */
    reportRunId: z.uuid(),
    /** Stable report identifier from `REPORT_REGISTRY`. */
    reportId: z.string().min(1).max(128),
    /** Schema version of the report definition. Stable for the lifetime
     *  of a registered report version; increments on incompatible
     *  parameter/aggregate shape changes. */
    reportVersion: z.int().min(1).max(255),
    /** Number of rows the runner produced. Persisted denormalized on
     *  `report_run` for fast filtering ("which runs returned > 0 rows
     *  this quarter?") without scanning the row set. */
    rowCount: z.int().min(0),
    /** Scalar aggregates surfaced by the report — counts, sums,
     *  averages. PHI-free by construction; see header note. */
    aggregates: z.record(z.string(), z.number()),
    /** ISO-8601 window the report covered. The values come from the
     *  parsed report parameters (e.g. a date-range filter) so the
     *  downstream stream is self-describing without joining back to
     *  the `report_run.parameters` JSON. */
    windowFrom: z.iso.datetime({ offset: true }),
    windowTo: z.iso.datetime({ offset: true }),
    /** Wall-clock time the runner produced the result set. */
    generatedAt: z.iso.datetime({ offset: true }),
    /** Operator who dispatched the run, OR the per-org service
     *  user when fired by the scheduled-run worker. Always present
     *  — the bus rejects a command without an actor. Consumers
     *  that want to distinguish "operator clicked Run" from
     *  "cron fired" should switch on `runViaScheduleId` (null
     *  for operator-initiated, present for scheduled). */
    runByUserId: z.uuid().nullable(),
    /** When set, the run was dispatched by the scheduled-run
     *  worker against this `report_schedule.id`. When `null`, the
     *  run was operator-initiated from the /ops/reports surface.
     *  Powers the notification handler's "only fan out scheduled
     *  runs" filter — operator-initiated runs already streamed
     *  the CSV to the browser, no email needed. */
    runViaScheduleId: z.uuid().nullable(),
  })
  .strict();

export const ReportingRunCompletedV1 = defineEvent({
  name: "reporting.run.completed",
  version: 1,
  aggregateType: "ReportRun",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.reportRunId,
  owner: "reporting",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.reporting",
  description:
    "Emitted by RunReport after a registered report finishes executing and the report_run ledger row is persisted. Carries report id + version, window, row count, and aggregates — never the row set itself. Powers future scheduled-run reconciliation, BI ingestion, and operator notification fan-out.",
});

export type ReportingRunCompletedV1Payload = z.infer<typeof payloadSchema>;
