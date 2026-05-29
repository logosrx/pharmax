// reporting.schedule.disabled.v1 — a scheduled report row was disabled
// via the `DisableReportSchedule` command.
//
// Producer: `DisableReportSchedule` (`@pharmax/reporting`).
//   The command is idempotent: a second disable call on an already-
//   DISABLED row is audited (action=`report.schedule.disable_redundant`)
//   but emits NO outbox event. This event fires ONLY on the
//   ACTIVE → DISABLED transition.
//
// Consumers (current):
//   - none yet.
//
// Consumers (future):
//   - Worker drain: stop projecting this schedule into the "due"
//     query (the partial index on report_schedule already filters
//     DISABLED rows out of the hot path; this event is the
//     belt-and-suspenders signal for in-memory caches).
//   - Notification adapter: confirm-mail to subscribers.
//   - BI/analytics: schedule-lifetime dashboard.
//
// PHI invariant: same as the create event — schedules carry no PHI.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    /** `report_schedule.id` — the row that was disabled. */
    reportScheduleId: z.uuid(),
    /** Stable report identifier from `REPORT_REGISTRY`. */
    reportId: z.string().min(1).max(128),
  })
  .strict();

export const ReportScheduleDisabledV1 = defineEvent({
  name: "reporting.schedule.disabled",
  version: 1,
  aggregateType: "ReportSchedule",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.reportScheduleId,
  owner: "reporting",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.reporting",
  description:
    "Emitted by DisableReportSchedule ONLY on the ACTIVE→DISABLED transition (idempotent redundant disables emit nothing). Carries the schedule id and report id so downstream caches can stop projecting this schedule into the due queue.",
});

export type ReportScheduleDisabledV1Payload = z.infer<typeof payloadSchema>;
