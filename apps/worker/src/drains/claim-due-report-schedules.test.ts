import { describe, expect, it, vi } from "vitest";

import {
  claimDueReportSchedules,
  type ReportScheduleClaimClient,
} from "./claim-due-report-schedules.js";

function makeClient(rows: ReadonlyArray<Record<string, unknown>>): ReportScheduleClaimClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows),
  } as unknown as ReportScheduleClaimClient;
}

describe("claimDueReportSchedules", () => {
  it("returns an empty array when no schedules are due", async () => {
    const client = makeClient([]);
    const out = await claimDueReportSchedules(client, { batchSize: 25 });
    expect(out).toEqual([]);
  });

  it("projects + freezes returned rows; defaults a missing template to {}", async () => {
    const nextRunAt = new Date("2026-05-28T09:00:00.000Z");
    const client = makeClient([
      {
        id: "sch-1",
        organizationId: "org-1",
        reportId: "order-volume-by-stage",
        cronExpression: "0 9 * * 1",
        timezone: "America/New_York",
        parametersTemplate: { from: "now-7d", to: "now" },
        nextRunAt,
      },
      {
        id: "sch-2",
        organizationId: "org-2",
        reportId: "sla-breach-report",
        cronExpression: "*/15 * * * *",
        timezone: "UTC",
        parametersTemplate: null, // tolerate missing
        nextRunAt: new Date("2026-05-28T09:15:00.000Z"),
      },
    ]);

    const out = await claimDueReportSchedules(client, { batchSize: 25 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "sch-1",
      organizationId: "org-1",
      reportId: "order-volume-by-stage",
      cronExpression: "0 9 * * 1",
      timezone: "America/New_York",
      parametersTemplate: { from: "now-7d", to: "now" },
      nextRunAt,
    });
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(out[1]!.parametersTemplate).toEqual({});
  });
});
