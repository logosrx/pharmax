// POST /api/ops/admin/report-schedules/[id]/update — dispatch
// UpdateReportSchedule and redirect back to the edit page.

import { UpdateReportSchedule } from "@pharmax/reporting";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

export const dynamic = "force-dynamic";

function readString(body: FormData | Record<string, unknown>, key: string): string {
  const v = body instanceof FormData ? body.get(key) : body[key];
  return typeof v === "string" ? v : "";
}

function parseTemplate(raw: string): Record<string, unknown> | { error: string } {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "parametersTemplate must be a JSON object" };
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    return {
      error: `parametersTemplate is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NOTIFY_ON_VALUES = new Set(["ALWAYS", "FAILURE_ONLY", "NEVER"]);
type NotifyOn = "ALWAYS" | "FAILURE_ONLY" | "NEVER";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return dispatchOpsCommand({
    request,
    command: UpdateReportSchedule,
    buildInput: ({ body }) => {
      const name = readString(body, "name").trim();
      const cronExpression = readString(body, "cronExpression").trim();
      const timezone = readString(body, "timezone").trim();
      const status = readString(body, "status").trim();
      const templateRaw = readString(body, "parametersTemplate");
      const notifyOnRaw = readString(body, "notifyOn").trim();

      const tpl = parseTemplate(templateRaw);
      if ("error" in tpl) return tpl;

      const allowedStatuses = new Set(["ACTIVE", "PAUSED", "DISABLED"]);
      const statusTyped = allowedStatuses.has(status)
        ? (status as "ACTIVE" | "PAUSED" | "DISABLED")
        : undefined;

      // recipients textarea is always sent by the form (even if
      // empty) so the UpdateReportSchedule command sees "user
      // submitted an empty list" as an explicit edit. Use the
      // existence of the field on the body to decide whether to
      // include the key in the input (omit means "don't change").
      const recipientsRawSubmitted =
        body instanceof FormData ? body.has("recipients") : "recipients" in body;
      const recipientsArr = recipientsRawSubmitted
        ? parseRecipients(readString(body, "recipients"))
        : undefined;

      const notifyOnTyped: NotifyOn | undefined = NOTIFY_ON_VALUES.has(notifyOnRaw)
        ? (notifyOnRaw as NotifyOn)
        : undefined;

      return {
        reportScheduleId: id,
        ...(name.length > 0 ? { name } : {}),
        ...(cronExpression.length > 0 ? { cronExpression } : {}),
        ...(timezone.length > 0 ? { timezone } : {}),
        parametersTemplate: tpl,
        ...(statusTyped !== undefined ? { status: statusTyped } : {}),
        ...(recipientsArr !== undefined ? { recipients: recipientsArr } : {}),
        ...(notifyOnTyped !== undefined ? { notifyOn: notifyOnTyped } : {}),
      };
    },
    idempotencyKeyPrefix: `ops:report-schedule:update:${id}`,
    successRedirect: () =>
      `/ops/admin/report-schedules/${id}/edit?flash=` + encodeURIComponent("Schedule updated."),
    failureRedirect: `/ops/admin/report-schedules/${id}/edit`,
    successLogEvent: "ops.report_schedule.update.ok",
    failureLogEvent: "ops.report_schedule.update.fail",
  });
}
