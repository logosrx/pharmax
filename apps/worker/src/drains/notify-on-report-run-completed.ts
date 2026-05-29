// Outbox handler for `reporting.run.completed.v1` events.
//
// Routes the run completion to the configured notification channel
// IF the run came from a schedule (i.e. payload's
// `runViaScheduleId` is non-null) AND the schedule's `notifyOn`
// preference says we should fan out for this run's outcome.
//
// Operator-initiated runs (no `runViaScheduleId`) are skipped —
// the operator already received the CSV in their browser, no email
// needed.
//
// Idempotency:
//   - Per-recipient idempotency key:
//     `report-run-notify:{reportRunId}:{recipient}` — the
//     NotificationChannel adapter dedupes on this. A retry of the
//     outbox row that re-enters this handler fans out the same
//     key for each recipient and the channel returns
//     `deduplicated` without double-sending.
//
// Per-recipient failures are isolated. A single bounce / 5xx for
// one recipient does NOT abort the rest of the fan-out; failures
// are logged with the recipient address + typed code so a
// downstream alerting rule can pick them up. The handler still
// THROWS if EVERY recipient failed — that returns the outbox row
// to RETRYING with backoff, so a total Resend outage flushes
// when the vendor recovers.
//
// PHI: the handler reads only operational metadata (schedule name,
// report id, aggregates which are scalars). The notification
// channel's `assertNoPhiInContext` guard is the structural backstop
// if a future code path were to pass PHI fields in `context`.

import type { PrismaClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
// withSystemContext is already imported below; the duplicate
// import here is intentionally left out so the file diff stays
// minimal.
import {
  getNotificationChannel,
  isNotificationTemplateId,
  NOTIFICATIONS_NOT_CONFIGURED,
} from "@pharmax/notifications";
import { REPORT_REGISTRY } from "@pharmax/reporting";
import { withSystemContext } from "@pharmax/tenancy";

import type { OutboxEventHandler } from "./outbox-handlers.js";

export interface CreateNotifyOnReportRunCompletedHandlerOptions {
  /**
   * Base URL of the operator console — used to build deep-links
   * back to the report's re-run page. e.g.
   * `"https://ops.pharmax.test"`. The handler appends
   * `/ops/reports/{reportId}` to compose the final URL.
   */
  readonly opsConsoleBaseUrl: string;
  readonly client: PrismaClient;
}

export function createNotifyOnReportRunCompletedHandler(
  options: CreateNotifyOnReportRunCompletedHandlerOptions
): OutboxEventHandler {
  return async (row, ctx) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    // SKIP gate 1 — non-scheduled runs. Operator-initiated runs
    // already streamed their CSV; no email needed.
    const runViaScheduleId = payload["runViaScheduleId"];
    if (typeof runViaScheduleId !== "string" || runViaScheduleId.length === 0) {
      return;
    }

    // SKIP gate 2 — notifications not configured (dev environments
    // where RESEND_API_KEY is unset). The configure module throws
    // NOTIFICATIONS_NOT_CONFIGURED on access; we treat that as a
    // benign skip + log so the outbox row marks DISPATCHED rather
    // than failing repeatedly.
    let channel: ReturnType<typeof getNotificationChannel>;
    try {
      channel = getNotificationChannel();
    } catch (cause) {
      const code =
        cause instanceof errors.PharmaxError ? cause.code : "NOTIFICATION_CHANNEL_RESOLVE_FAILED";
      if (code === NOTIFICATIONS_NOT_CONFIGURED) {
        ctx.logger.info("outbox.notify_report_run.skipped_no_channel", {
          outboxId: row.id,
          reportRunId: payload["reportRunId"],
        });
        return;
      }
      throw cause;
    }

    // Resolve the schedule's recipients + notifyOn preference.
    // System context: this drain runs cross-tenant; we read the
    // schedule row directly via the same per-org RLS bypass used
    // by every other drainer.
    const schedule = await withSystemContext(
      "worker-drain:notify-report-run.load-schedule",
      async () => {
        return options.client.reportSchedule.findUnique({
          where: { id: runViaScheduleId },
          select: {
            id: true,
            name: true,
            recipients: true,
            notifyOn: true,
            organizationId: true,
          },
        });
      }
    );

    if (schedule === null) {
      // Schedule was deleted between dispatch and notification —
      // the run row is still valid, just nobody to tell. Log +
      // mark DISPATCHED.
      ctx.logger.warn("outbox.notify_report_run.skipped_schedule_missing", {
        outboxId: row.id,
        runViaScheduleId,
      });
      return;
    }

    if (schedule.organizationId !== row.organizationId) {
      // Defense in depth — should never happen via the bus path,
      // but if it does the row is poison: log + drop.
      ctx.logger.error("outbox.notify_report_run.org_mismatch", {
        outboxId: row.id,
        payloadOrgId: row.organizationId,
        scheduleOrgId: schedule.organizationId,
      });
      return;
    }

    // SKIP gate 3 — notifyOn preference filters this outcome out.
    const runStatusRaw = inferRunStatus(payload);
    if (!shouldFanOut(schedule.notifyOn, runStatusRaw)) {
      ctx.logger.info("outbox.notify_report_run.skipped_notify_on", {
        outboxId: row.id,
        scheduleId: schedule.id,
        notifyOn: schedule.notifyOn,
        runStatus: runStatusRaw,
      });
      return;
    }

    // SKIP gate 4 — empty recipients list. A schedule with
    // notifyOn=ALWAYS but no recipients is the "scheduled but
    // silent" mode (audit trail only).
    if (schedule.recipients.length === 0) {
      ctx.logger.info("outbox.notify_report_run.skipped_no_recipients", {
        outboxId: row.id,
        scheduleId: schedule.id,
      });
      return;
    }

    // Compose the notification context.
    const templateId = "REPORT_RUN_COMPLETED_V1";
    if (!isNotificationTemplateId(templateId)) {
      throw new errors.InternalError({
        code: "NOTIFICATION_TEMPLATE_NOT_REGISTERED",
        message: `Template ${templateId} is missing from @pharmax/notifications registry.`,
        metadata: { outboxId: row.id },
      });
    }

    const reportId = String(payload["reportId"] ?? "");
    const reportDefinition = REPORT_REGISTRY[reportId];
    const reportTitle = reportDefinition?.title ?? reportId;
    const baseUrl = stripTrailingSlash(options.opsConsoleBaseUrl);
    const dashboardLink = `${baseUrl}/ops/reports/${encodeURIComponent(reportId)}`;

    const reportRunId = String(payload["reportRunId"] ?? row.aggregateId);

    // Check if the run has a persisted CSV — drives whether we
    // include a Download CSV button in the email. Done via a
    // narrow SELECT (system context, defense-in-depth org check
    // against the payload).
    const downloadLink = await maybeComposeDownloadLink({
      client: options.client,
      organizationId: row.organizationId,
      reportRunId,
      baseUrl,
    });

    const context: Record<string, unknown> = {
      scheduleName: schedule.name,
      reportTitle,
      runStatus: runStatusRaw,
      windowFromIso: String(payload["windowFrom"] ?? ""),
      windowToIso: String(payload["windowTo"] ?? ""),
      generatedAtIso: String(payload["generatedAt"] ?? ""),
      rowCount: Number(payload["rowCount"] ?? 0),
      aggregates: (payload["aggregates"] as Readonly<Record<string, number>>) ?? {},
      dashboardLink,
      ...(downloadLink !== null ? { downloadLink } : {}),
    };

    let succeeded = 0;
    const failures: Array<{ recipient: string; code: string; message: string }> = [];

    for (const recipient of schedule.recipients) {
      try {
        await channel.send({
          to: { kind: "email", address: recipient },
          template: templateId,
          context,
          idempotencyKey: `report-run-notify:${reportRunId}:${recipient}`,
          // Tenant + correlation so the PersistentNotificationChannel
          // decorator writes a notification_delivery row keyed on
          // (org, idempotencyKey) and rolls it up per report run.
          organizationId: row.organizationId,
          correlationId: reportRunId,
        });
        succeeded += 1;
      } catch (cause) {
        const code =
          cause instanceof errors.PharmaxError ? cause.code : "NOTIFICATION_TRANSPORT_ERROR";
        const message = cause instanceof Error ? cause.message : "Notification send failed.";
        failures.push({ recipient, code, message });
        // Per-recipient failure: log with the recipient address +
        // code, keep iterating. Sentry will pick up the full cause
        // via the global logger bridge.
        ctx.logger.warn("outbox.notify_report_run.recipient_failed", {
          outboxId: row.id,
          scheduleId: schedule.id,
          reportRunId,
          recipient,
          code,
          error: cause,
        });
      }
    }

    if (succeeded === 0 && failures.length > 0) {
      // Total failure: rethrow so the drainer marks the row
      // RETRYING with backoff. Resend bouncing every send for
      // one outbox row is almost always a vendor outage and we
      // want the retry loop, not a "permanently dispatched"
      // mark.
      throw new errors.InternalError({
        code: "NOTIFICATION_FANOUT_TOTAL_FAILURE",
        message: `All ${failures.length} recipient send(s) failed for schedule ${schedule.id}.`,
        metadata: {
          outboxId: row.id,
          scheduleId: schedule.id,
          reportRunId,
          firstFailureCode: failures[0]?.code,
        },
      });
    }

    ctx.logger.info("outbox.notify_report_run.dispatched", {
      outboxId: row.id,
      scheduleId: schedule.id,
      reportRunId,
      succeeded,
      failed: failures.length,
    });
  };
}

/**
 * Pull `runStatus` out of the outbox payload. The producer
 * (`RunReport`) only emits run-completed for SUCCEEDED outcomes;
 * the worker tick writes an outbox event for FAILED/SKIPPED via
 * a separate path (handled at the schedule row, not via outbox).
 * If the payload doesn't carry a status, we treat it as SUCCEEDED
 * (the producer's invariant).
 */
function inferRunStatus(payload: Record<string, unknown>): "SUCCEEDED" | "FAILED" | "SKIPPED" {
  const v = payload["runStatus"];
  if (v === "SUCCEEDED" || v === "FAILED" || v === "SKIPPED") {
    return v;
  }
  return "SUCCEEDED";
}

function shouldFanOut(
  notifyOn: "ALWAYS" | "FAILURE_ONLY" | "NEVER",
  status: "SUCCEEDED" | "FAILED" | "SKIPPED"
): boolean {
  switch (notifyOn) {
    case "ALWAYS":
      return true;
    case "FAILURE_ONLY":
      return status === "FAILED" || status === "SKIPPED";
    case "NEVER":
      return false;
    default: {
      const exhaustive: never = notifyOn;
      throw new Error(`Unknown notifyOn: ${String(exhaustive)}`);
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Resolve the report_run row in system context and compose the
 * deep-link download URL when a CSV has been archived. Returns
 * `null` when the row has no `csvObjectKey` (the operator gets
 * a re-run dashboard link only).
 *
 * Cross-checks the row's `organizationId` against the payload's
 * org — same defense-in-depth pattern the handler's earlier
 * `schedule.organizationId !== row.organizationId` check uses.
 */
async function maybeComposeDownloadLink(input: {
  readonly client: PrismaClient;
  readonly organizationId: string;
  readonly reportRunId: string;
  readonly baseUrl: string;
}): Promise<string | null> {
  const row = await withSystemContext("worker-drain:notify-report-run.load-run", async () => {
    return input.client.reportRun.findUnique({
      where: { id: input.reportRunId },
      select: {
        organizationId: true,
        csvObjectKey: true,
      },
    });
  });
  if (row === null) return null;
  if (row.organizationId !== input.organizationId) return null;
  if (row.csvObjectKey === null) return null;
  return `${input.baseUrl}/api/ops/reports/runs/${encodeURIComponent(input.reportRunId)}/download`;
}
