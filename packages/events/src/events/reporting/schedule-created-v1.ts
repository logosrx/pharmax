// reporting.schedule.created.v1 — a new scheduled-report row was
// persisted via the `CreateReportSchedule` command.
//
// Producer: `CreateReportSchedule` (`@pharmax/reporting`).
//
// Consumers (current):
//   - none yet. Today the event is fan-out optionality + a tamper-
//     evident downstream record paired with the `report_schedule`
//     row.
//
// Consumers (future):
//   - BI/analytics ingestion: project a "scheduled reports per
//     clinic" dashboard.
//   - Notification adapter: optional "your schedule has been
//     created" email to the creating user.
//   - Worker drain telemetry: pair create events with the first
//     `reporting.run.completed.v1` carrying `runViaScheduleId =
//     reportScheduleId` to compute schedule lag.
//
// PHI invariant: report schedules carry NO PHI by construction.
// Names (e.g. "Weekly SLA breaches") and cron expressions are
// operational metadata. The `reportId` is a registry token, not
// patient data.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    /** `report_schedule.id` — the persisted row. */
    reportScheduleId: z.uuid(),
    /** Stable report identifier from `REPORT_REGISTRY`. */
    reportId: z.string().min(1).max(128),
    /** Operator-provided display name. */
    name: z.string().min(1).max(255),
    /** Cron expression in the user's `timezone`. */
    cronExpression: z.string().min(1).max(255),
    /** IANA timezone the cron is evaluated in. */
    timezone: z.string().min(1).max(64),
    /** ISO-8601 next-run timestamp computed at create time. */
    nextRunAt: z.iso.datetime({ offset: true }),
    /** Number of notification recipients on the schedule (we
     *  carry COUNT not addresses — recipient lists are operator
     *  metadata, but there's no need to spray them across every
     *  event payload). */
    recipientCount: z.int().min(0).max(50),
    /** Notification cadence preference. */
    notifyOn: z.enum(["ALWAYS", "FAILURE_ONLY", "NEVER"]),
    /** Pharmax user id of the operator who created the schedule. */
    createdByUserId: z.uuid(),
    /** Wall-clock time the command committed. */
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ReportScheduleCreatedV1 = defineEvent({
  name: "reporting.schedule.created",
  version: 1,
  aggregateType: "ReportSchedule",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.reportScheduleId,
  owner: "reporting",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.reporting",
  description:
    "Emitted by CreateReportSchedule after a scheduled-report row is persisted. Carries the schedule id, the target report id, the cron expression + timezone, and the first nextRunAt — the inputs a downstream worker drain needs to reconcile schedule firing against report_run rows.",
});

export type ReportScheduleCreatedV1Payload = z.infer<typeof payloadSchema>;
