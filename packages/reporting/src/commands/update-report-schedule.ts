// UpdateReportSchedule — admin edits an existing schedule.
//
// Supports four edit modes (any combination, all optional):
//   - `name`               — rename for clarity.
//   - `cronExpression`     — recomputes nextRunAt anchored at the
//     server clock at update time (NOT the current nextRunAt;
//     the operator's intent is "fire on the new schedule
//     starting now", not "fire on the new schedule starting
//     from the old next-fire").
//   - `timezone`           — same recompute as cronExpression.
//   - `parametersTemplate` — re-validated against the report's
//     own Zod schema after placeholder resolution at now.
//   - `status`             — ACTIVE / PAUSED / DISABLED. Changing
//     status alone does NOT recompute nextRunAt (the worker tick
//     handles the nextRunAt advance on the next ACTIVE state).
//
// Refuses to change `reportId` — that's a fundamentally different
// schedule. Operators who want a different report create a new
// schedule + disable the old.
//
// PHI invariant: same as CreateReportSchedule.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { type ReportScheduleStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { REPORT_REGISTRY, type ReportDefinitionAny } from "../report-registry.js";
import { validateCron } from "../schedule/cron.js";
import { resolveTemplate } from "../schedule/resolve-template.js";
import { CRON_EXPRESSION_INVALID, SCHEDULE_TEMPLATE_INVALID } from "./create-report-schedule.js";

export const REPORT_SCHEDULE_NOT_FOUND = "REPORT_SCHEDULE_NOT_FOUND";

const inputSchema = z
  .object({
    reportScheduleId: z.uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    cronExpression: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    parametersTemplate: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]).optional(),
    recipients: z.array(z.email()).max(50).optional(),
    notifyOn: z.enum(["ALWAYS", "FAILURE_ONLY", "NEVER"]).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.cronExpression !== undefined ||
      v.timezone !== undefined ||
      v.parametersTemplate !== undefined ||
      v.status !== undefined ||
      v.recipients !== undefined ||
      v.notifyOn !== undefined,
    { message: "at least one editable field must be supplied" }
  );

export type UpdateReportScheduleInput = z.infer<typeof inputSchema>;

export interface UpdateReportScheduleOutput {
  readonly reportScheduleId: string;
  readonly fieldsChanged: ReadonlyArray<string>;
  readonly nextRunAt: string; // ISO
}

export const UpdateReportSchedule: Command<UpdateReportScheduleInput, UpdateReportScheduleOutput> =
  {
    name: "UpdateReportSchedule",
    inputSchema,
    permission: PERMISSIONS.REPORTS_MANAGE_SCHEDULE,
    redactFields: [],

    async handle({
      input,
      ctx,
      tx,
      commandLogId,
      clock,
    }): Promise<HandlerResult<UpdateReportScheduleOutput>> {
      const existing = await tx.reportSchedule.findFirst({
        where: { id: input.reportScheduleId, organizationId: ctx.organizationId },
        select: {
          id: true,
          reportId: true,
          name: true,
          cronExpression: true,
          timezone: true,
          parametersTemplate: true,
          status: true,
          nextRunAt: true,
          recipients: true,
          notifyOn: true,
        },
      });
      if (existing === null) {
        throw new errors.NotFoundError({
          code: REPORT_SCHEDULE_NOT_FOUND,
          message: "Report schedule not found in this organization.",
          metadata: { reportScheduleId: input.reportScheduleId },
        });
      }

      const now = clock.now();
      const definition = REPORT_REGISTRY[existing.reportId] as ReportDefinitionAny | undefined;
      // If the report id is no longer in the registry, we still
      // allow STATUS-only edits (so the admin can DISABLE a stale
      // schedule), but reject anything that touches cron / params.
      const wantsContentEdit =
        input.cronExpression !== undefined ||
        input.timezone !== undefined ||
        input.parametersTemplate !== undefined;
      if (definition === undefined && wantsContentEdit) {
        throw new errors.ConflictError({
          code: "REPORT_DEFINITION_MISSING",
          message: `Report "${existing.reportId}" is no longer registered. Only status edits are allowed.`,
          metadata: { reportId: existing.reportId },
        });
      }

      // Re-validate cron if the operator touched it (or the
      // timezone, which changes the cron's anchor).
      let newNextRunAt: Date = existing.nextRunAt;
      if (input.cronExpression !== undefined || input.timezone !== undefined) {
        const expr = input.cronExpression ?? existing.cronExpression;
        const tz = input.timezone ?? existing.timezone;
        const cronResult = validateCron({ expression: expr, timezone: tz, from: now });
        if (!cronResult.ok) {
          throw new errors.ValidationError({
            code: CRON_EXPRESSION_INVALID,
            message: `cron expression "${expr}" did not parse: ${cronResult.error}`,
            metadata: { cronExpression: expr, timezone: tz },
          });
        }
        newNextRunAt = cronResult.nextRunAt;
      }

      // Re-validate the template against the report's schema if
      // the operator touched it (definition is guaranteed non-null
      // here per the wantsContentEdit gate above).
      if (input.parametersTemplate !== undefined && definition !== undefined) {
        const resolved = resolveTemplate({
          template: input.parametersTemplate,
          now,
        });
        const dryRun = definition.parametersSchema.safeParse(resolved);
        if (!dryRun.success) {
          throw new errors.ValidationError({
            code: SCHEDULE_TEMPLATE_INVALID,
            message: `parametersTemplate did not pass "${existing.reportId}"'s parameter schema (after placeholder resolution).`,
            metadata: { reportId: existing.reportId, issues: dryRun.error.flatten() },
          });
        }
      }

      const fieldsChanged: string[] = [];
      const data: Record<string, unknown> = {};
      if (input.name !== undefined && input.name !== existing.name) {
        data["name"] = input.name;
        fieldsChanged.push("name");
      }
      if (input.cronExpression !== undefined && input.cronExpression !== existing.cronExpression) {
        data["cronExpression"] = input.cronExpression;
        fieldsChanged.push("cronExpression");
      }
      if (input.timezone !== undefined && input.timezone !== existing.timezone) {
        data["timezone"] = input.timezone;
        fieldsChanged.push("timezone");
      }
      if (input.parametersTemplate !== undefined) {
        data["parametersTemplate"] = input.parametersTemplate as object;
        fieldsChanged.push("parametersTemplate");
      }
      if (input.status !== undefined && input.status !== existing.status) {
        data["status"] = input.status;
        fieldsChanged.push("status");
      }
      if (input.recipients !== undefined) {
        // De-duplicate + lowercase at the boundary so two callers
        // that disagree on case don't generate "different" recipient
        // lists that fan out twice from the handler.
        const deduped = Array.from(new Set(input.recipients.map((e) => e.toLowerCase())));
        const sameLength = deduped.length === existing.recipients.length;
        const sameMembers =
          sameLength && deduped.every((addr, i) => addr === existing.recipients[i]?.toLowerCase());
        if (!sameMembers) {
          data["recipients"] = deduped;
          fieldsChanged.push("recipients");
        }
      }
      if (input.notifyOn !== undefined && input.notifyOn !== existing.notifyOn) {
        data["notifyOn"] = input.notifyOn;
        fieldsChanged.push("notifyOn");
      }
      if (newNextRunAt.getTime() !== existing.nextRunAt.getTime()) {
        data["nextRunAt"] = newNextRunAt;
      }

      if (Object.keys(data).length > 0) {
        await tx.reportSchedule.update({
          where: { id: existing.id },
          data,
        });
      }

      return {
        output: Object.freeze({
          reportScheduleId: existing.id,
          fieldsChanged: Object.freeze([...fieldsChanged]),
          nextRunAt: newNextRunAt.toISOString(),
        }),
        audit: {
          action: "report.schedule.updated",
          resourceType: "ReportSchedule",
          resourceId: existing.id,
          metadata: {
            reportScheduleId: existing.id,
            reportId: existing.reportId,
            fieldsChanged: [...fieldsChanged],
            newStatus: (input.status ?? existing.status) as ReportScheduleStatus,
            commandLogId,
          },
        },
        outboxEvents: [
          {
            eventType: "reporting.schedule.updated.v1",
            aggregateType: "ReportSchedule",
            aggregateId: existing.id,
            payload: {
              organizationId: ctx.organizationId,
              reportScheduleId: existing.id,
              reportId: existing.reportId,
              fieldsChanged: [...fieldsChanged],
              newStatus: (input.status ?? existing.status) as ReportScheduleStatus,
              nextRunAt: newNextRunAt.toISOString(),
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
