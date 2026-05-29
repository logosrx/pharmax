// POST /api/ops/admin/report-schedules/[id]/disable — dispatch
// DisableReportSchedule and redirect back to the list with a
// flash message.

import { DisableReportSchedule } from "@pharmax/reporting";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return dispatchOpsCommand({
    request,
    command: DisableReportSchedule,
    buildInput: () => ({ reportScheduleId: id }),
    idempotencyKeyPrefix: `ops:report-schedule:disable:${id}`,
    successRedirect: (out) =>
      "/ops/admin/report-schedules?flash=" +
      encodeURIComponent(
        out.wasAlreadyDisabled ? "Schedule was already disabled." : "Schedule disabled."
      ),
    failureRedirect: `/ops/admin/report-schedules/${id}/edit`,
    successLogEvent: "ops.report_schedule.disable.ok",
    failureLogEvent: "ops.report_schedule.disable.fail",
  });
}
