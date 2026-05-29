// DisableReportSchedule — soft-delete a scheduled report.
//
// Soft-delete (status = DISABLED) rather than hard delete so the
// audit trail remains intact: a SOC-2 reviewer can ask "what
// schedules were configured for this org last year" and the
// answer is in the DB, not in archived logs.
//
// DISABLED schedules are excluded from the worker's claim query
// (partial index `report_schedule_due_idx` filters on
// `status = 'ACTIVE'`), so they don't fire. They remain visible
// + editable in the admin UI; an admin who wants to resume a
// DISABLED schedule uses UpdateReportSchedule with
// `{ status: "ACTIVE" }`.
//
// Idempotent: calling on an already-DISABLED row is a no-op
// (audited as `report.schedule.disable_redundant` so the
// reviewer can distinguish reaffirming intent from fresh
// disables).

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { REPORT_SCHEDULE_NOT_FOUND } from "./update-report-schedule.js";

const inputSchema = z
  .object({
    reportScheduleId: z.uuid(),
  })
  .strict();

export type DisableReportScheduleInput = z.infer<typeof inputSchema>;

export interface DisableReportScheduleOutput {
  readonly reportScheduleId: string;
  readonly wasAlreadyDisabled: boolean;
}

export const DisableReportSchedule: Command<
  DisableReportScheduleInput,
  DisableReportScheduleOutput
> = {
  name: "DisableReportSchedule",
  inputSchema,
  permission: PERMISSIONS.REPORTS_MANAGE_SCHEDULE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<DisableReportScheduleOutput>> {
    const existing = await tx.reportSchedule.findFirst({
      where: { id: input.reportScheduleId, organizationId: ctx.organizationId },
      select: { id: true, reportId: true, name: true, status: true },
    });
    if (existing === null) {
      throw new errors.NotFoundError({
        code: REPORT_SCHEDULE_NOT_FOUND,
        message: "Report schedule not found in this organization.",
        metadata: { reportScheduleId: input.reportScheduleId },
      });
    }

    const wasAlreadyDisabled = existing.status === "DISABLED";
    if (!wasAlreadyDisabled) {
      await tx.reportSchedule.update({
        where: { id: existing.id },
        data: { status: "DISABLED" },
      });
    }

    return {
      output: Object.freeze({
        reportScheduleId: existing.id,
        wasAlreadyDisabled,
      }),
      audit: {
        action: wasAlreadyDisabled
          ? "report.schedule.disable_redundant"
          : "report.schedule.disabled",
        resourceType: "ReportSchedule",
        resourceId: existing.id,
        metadata: {
          reportScheduleId: existing.id,
          reportId: existing.reportId,
          name: existing.name,
          commandLogId,
        },
      },
      outboxEvents: wasAlreadyDisabled
        ? []
        : [
            {
              eventType: "reporting.schedule.disabled.v1",
              aggregateType: "ReportSchedule",
              aggregateId: existing.id,
              payload: {
                organizationId: ctx.organizationId,
                reportScheduleId: existing.id,
                reportId: existing.reportId,
              },
            },
          ],
    };
  },
};
