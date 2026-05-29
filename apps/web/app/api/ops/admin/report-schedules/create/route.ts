// POST /api/ops/admin/report-schedules/create — dispatch
// CreateReportSchedule and redirect back to the list with a flash
// message.

import { CreateReportSchedule } from "@pharmax/reporting";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

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

/**
 * Parse the recipients textarea. Accepts comma, semicolon,
 * whitespace, or newline separators (operators paste lists from a
 * variety of sources). Empty input is the "scheduled but silent"
 * mode and is valid.
 */
function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NOTIFY_ON_VALUES = new Set(["ALWAYS", "FAILURE_ONLY", "NEVER"]);
type NotifyOn = "ALWAYS" | "FAILURE_ONLY" | "NEVER";

export async function POST(request: Request): Promise<Response> {
  return dispatchOpsCommand({
    request,
    command: CreateReportSchedule,
    buildInput: ({ body }) => {
      const name = readString(body, "name").trim();
      const reportId = readString(body, "reportId").trim();
      const cronExpression = readString(body, "cronExpression").trim();
      const timezone = readString(body, "timezone").trim() || "UTC";
      const templateRaw = readString(body, "parametersTemplate");
      const recipients = parseRecipients(readString(body, "recipients"));
      const notifyOnRaw = readString(body, "notifyOn").trim();
      if (name.length === 0) return { error: "name is required" };
      if (reportId.length === 0) return { error: "reportId is required" };
      if (cronExpression.length === 0) return { error: "cronExpression is required" };
      const tpl = parseTemplate(templateRaw);
      if ("error" in tpl) return tpl;
      const notifyOn: NotifyOn = NOTIFY_ON_VALUES.has(notifyOnRaw)
        ? (notifyOnRaw as NotifyOn)
        : "ALWAYS";
      return {
        name,
        reportId,
        cronExpression,
        timezone,
        parametersTemplate: tpl,
        recipients,
        notifyOn,
      };
    },
    idempotencyKeyPrefix: "ops:report-schedule:create",
    successRedirect: () =>
      "/ops/admin/report-schedules?flash=" +
      encodeURIComponent("Schedule created — next fire computed."),
    failureRedirect: "/ops/admin/report-schedules/new",
    successLogEvent: "ops.report_schedule.create.ok",
    failureLogEvent: "ops.report_schedule.create.fail",
  });
}
