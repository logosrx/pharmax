// reporting.schedule.updated.v1 — fields on an existing scheduled
// report row were changed via the `UpdateReportSchedule` command.
//
// Producer: `UpdateReportSchedule` (`@pharmax/reporting`).
//
// Consumers (current):
//   - none yet.
//
// Consumers (future):
//   - Notification adapter: alert the creator/subscribers when a
//     schedule's cadence or status changes.
//   - BI/analytics: change-log dashboard for ops governance.
//   - Worker drain: invalidate any in-flight planning state if the
//     schedule's cron expression or timezone changed.
//
// PHI invariant: same as the create event — schedules carry no PHI.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    /** `report_schedule.id` — the row that was mutated. */
    reportScheduleId: z.uuid(),
    /** Stable report identifier from `REPORT_REGISTRY` (carried so
     *  consumers can route by report kind without joining back to
     *  the row). */
    reportId: z.string().min(1).max(128),
    /** The fields that changed in this update — column names as
     *  emitted by the command's diff. Empty array MEANS no fields
     *  changed (no-op update); the command emits an event anyway
     *  for audit traceability. */
    fieldsChanged: z.array(z.string().min(1).max(64)).readonly(),
    /** Schedule status AFTER the update. PAUSED is a soft "skip
     *  the tick but keep the row" state — distinct from DISABLED
     *  (which is the soft-delete). */
    newStatus: z.enum(["ACTIVE", "PAUSED", "DISABLED"]),
    /** ISO-8601 next-run timestamp after the update. Recomputed by
     *  the command when the cron expression or timezone changes. */
    nextRunAt: z.iso.datetime({ offset: true }),
    /** Wall-clock time the command committed. */
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ReportScheduleUpdatedV1 = defineEvent({
  name: "reporting.schedule.updated",
  version: 1,
  aggregateType: "ReportSchedule",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.reportScheduleId,
  owner: "reporting",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.reporting",
  description:
    "Emitted by UpdateReportSchedule after fields on a report_schedule row are mutated. Carries the changed-fields diff, the post-update status, and the recomputed nextRunAt so downstream consumers can react without re-reading the row.",
});

export type ReportScheduleUpdatedV1Payload = z.infer<typeof payloadSchema>;
