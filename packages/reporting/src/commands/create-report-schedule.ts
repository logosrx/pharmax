// CreateReportSchedule — admin creates a cron-driven schedule
// for a registered report.
//
// Validation:
//   - `reportId` MUST resolve to a definition in REPORT_REGISTRY.
//   - `cronExpression` + `timezone` MUST parse via cron-parser
//     (failure → typed `CRON_EXPRESSION_INVALID` error with the
//     library's message).
//   - `parametersTemplate` MUST shape-match against the report's
//     own Zod schema AFTER placeholder resolution at a synthetic
//     `now`. We resolve once at create time to surface obvious
//     misconfigs ("template includes from=now-30d but the
//     report's schema rejects from > to") immediately rather
//     than waiting for the worker tick.
//
// Idempotency:
//   - DB unique on `(organizationId, reportId, name)`. Duplicate
//     creates surface as `SCHEDULE_NAME_TAKEN`.
//
// Permission: `reports.manage_schedule`.
//
// PHI invariant: no PHI in inputs or persisted columns.
// `parametersTemplate` is a non-PHI shape today (date placeholders
// + status enums). The bus's `redactFields` is empty; when a PHI-
// bearing parameter lands on a report, the parameter schema gates
// it AND this list MUST be updated.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma, type ReportScheduleNotifyOn, type ReportScheduleStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { REPORT_REGISTRY, type ReportDefinitionAny } from "../report-registry.js";
import { validateCron } from "../schedule/cron.js";
import { resolveTemplate } from "../schedule/resolve-template.js";

export const REPORT_NOT_FOUND = "REPORT_NOT_FOUND";
export const CRON_EXPRESSION_INVALID = "CRON_EXPRESSION_INVALID";
export const SCHEDULE_TEMPLATE_INVALID = "SCHEDULE_TEMPLATE_INVALID";
export const SCHEDULE_NAME_TAKEN = "SCHEDULE_NAME_TAKEN";

const inputSchema = z
  .object({
    /** Human-friendly label, unique per (org, reportId). */
    name: z.string().trim().min(1).max(120),
    reportId: z.string().trim().min(1).max(128),
    cronExpression: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(64).default("UTC"),
    parametersTemplate: z.record(z.string(), z.unknown()),
    /**
     * Operator email addresses to notify on each dispatch. May be
     * empty (the schedule still runs; nobody hears about it).
     * Capped at 50 entries — past that the operator should use a
     * mailing list, not a recipient column.
     */
    recipients: z.array(z.email()).max(50).default([]),
    /**
     * When to fan the run completion out to `recipients`. Default
     * ALWAYS matches the operator's expectation that scheduling a
     * report means receiving the report. FAILURE_ONLY is the
     * "no news is good news" mode for noisy schedules; NEVER mutes
     * notifications without stopping execution.
     */
    notifyOn: z.enum(["ALWAYS", "FAILURE_ONLY", "NEVER"]).default("ALWAYS"),
  })
  .strict();

export type CreateReportScheduleInput = z.infer<typeof inputSchema>;

export interface CreateReportScheduleOutput {
  readonly reportScheduleId: string;
  readonly reportId: string;
  readonly name: string;
  readonly nextRunAt: string; // ISO
  readonly status: ReportScheduleStatus;
  readonly recipientCount: number;
  readonly notifyOn: ReportScheduleNotifyOn;
}

export const CreateReportSchedule: Command<CreateReportScheduleInput, CreateReportScheduleOutput> =
  {
    name: "CreateReportSchedule",
    inputSchema,
    permission: PERMISSIONS.REPORTS_MANAGE_SCHEDULE,
    redactFields: [],

    async handle({
      input,
      ctx,
      tx,
      commandLogId,
      clock,
    }): Promise<HandlerResult<CreateReportScheduleOutput>> {
      // 1. Resolve report id.
      const definition = REPORT_REGISTRY[input.reportId] as ReportDefinitionAny | undefined;
      if (definition === undefined) {
        throw new errors.NotFoundError({
          code: REPORT_NOT_FOUND,
          message: `No report registered with id "${input.reportId}".`,
          metadata: { reportId: input.reportId },
        });
      }

      // 2. Validate cron expression + compute initial nextRunAt.
      const now = clock.now();
      const cronResult = validateCron({
        expression: input.cronExpression,
        timezone: input.timezone,
        from: now,
      });
      if (!cronResult.ok) {
        throw new errors.ValidationError({
          code: CRON_EXPRESSION_INVALID,
          message: `cron expression "${input.cronExpression}" did not parse: ${cronResult.error}`,
          metadata: {
            cronExpression: input.cronExpression,
            timezone: input.timezone,
          },
        });
      }

      // 3. Resolve template placeholders + dry-run against report's
      //    own Zod schema. Surfaces template/schema mismatches at
      //    create time rather than at first tick.
      const resolvedAtNow = resolveTemplate({ template: input.parametersTemplate, now });
      const dryRun = definition.parametersSchema.safeParse(resolvedAtNow);
      if (!dryRun.success) {
        throw new errors.ValidationError({
          code: SCHEDULE_TEMPLATE_INVALID,
          message: `parametersTemplate did not pass "${input.reportId}"'s parameter schema (after placeholder resolution).`,
          metadata: {
            reportId: input.reportId,
            issues: dryRun.error.flatten(),
          },
        });
      }

      // De-duplicate the recipient list at the boundary so a typo
      // like `["a@x.test", "a@x.test"]` doesn't send two copies of
      // the same email at fanout time. Order preserved on first
      // occurrence so the admin UI displays them in the order the
      // operator typed them.
      const dedupedRecipients = Array.from(new Set(input.recipients.map((e) => e.toLowerCase())));

      // 4. Insert. Catch P2002 on the unique (org, reportId, name).
      let created: { id: string };
      try {
        created = await tx.reportSchedule.create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name,
            reportId: input.reportId,
            cronExpression: input.cronExpression,
            timezone: input.timezone,
            parametersTemplate: input.parametersTemplate as object,
            status: "ACTIVE",
            nextRunAt: cronResult.nextRunAt,
            recipients: dedupedRecipients,
            notifyOn: input.notifyOn,
            createdByUserId: ctx.actor.userId,
            createCommandLogId: commandLogId,
          },
          select: { id: true },
        });
      } catch (cause) {
        if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
          throw new errors.ConflictError({
            code: SCHEDULE_NAME_TAKEN,
            message: `A schedule named "${input.name}" already exists for report "${input.reportId}" in this org.`,
            metadata: { reportId: input.reportId, name: input.name },
            cause,
          });
        }
        throw cause;
      }

      return {
        output: Object.freeze({
          reportScheduleId: created.id,
          reportId: input.reportId,
          name: input.name,
          nextRunAt: cronResult.nextRunAt.toISOString(),
          status: "ACTIVE" as ReportScheduleStatus,
          recipientCount: dedupedRecipients.length,
          notifyOn: input.notifyOn as ReportScheduleNotifyOn,
        }),
        audit: {
          action: "report.schedule.created",
          resourceType: "ReportSchedule",
          resourceId: created.id,
          metadata: {
            reportId: input.reportId,
            name: input.name,
            cronExpression: input.cronExpression,
            timezone: input.timezone,
            nextRunAtIso: cronResult.nextRunAt.toISOString(),
            // recipient COUNT, not the email addresses themselves.
            // Operator emails are operator metadata (not PHI) but
            // there's no need to repeat them on every audit row.
            recipientCount: dedupedRecipients.length,
            notifyOn: input.notifyOn,
            commandLogId,
          },
        },
        outboxEvents: [
          {
            eventType: "reporting.schedule.created.v1",
            aggregateType: "ReportSchedule",
            aggregateId: created.id,
            payload: {
              organizationId: ctx.organizationId,
              reportScheduleId: created.id,
              reportId: input.reportId,
              name: input.name,
              cronExpression: input.cronExpression,
              timezone: input.timezone,
              nextRunAt: cronResult.nextRunAt.toISOString(),
              recipientCount: dedupedRecipients.length,
              notifyOn: input.notifyOn,
              createdByUserId: ctx.actor.userId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
