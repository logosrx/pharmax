// Report scheduler tick tests.
//
// Approach: mock the cross-tenant claim + per-org actor lookup +
// schedule.update and assert outcomes. RunReport is wired by
// patching the bus's executeCommand. The actual cron computation
// and template resolution are exercised by their own unit tests;
// here we only assert that the dispatcher CALLED them correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeCommandMock = vi.hoisted(() =>
  vi.fn(async (_cmd: unknown, _input: unknown) => ({
    reportRunId: "rr-1",
    rowCount: 7,
    reportId: "order-volume-by-stage",
    reportVersion: 1,
    aggregates: {},
  }))
);

vi.mock("@pharmax/command-bus", () => ({
  executeCommand: executeCommandMock,
}));

vi.mock("./claim-due-report-schedules.js", () => ({
  claimDueReportSchedules: vi.fn(),
}));

import { logger } from "@pharmax/platform-core";

import { claimDueReportSchedules } from "./claim-due-report-schedules.js";
import { createReportScheduler } from "./report-scheduler.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000077";
const SERVICE_USER_ID = "00000000-0000-4000-8000-000000000099";

const DUE_ROW = Object.freeze({
  id: SCHEDULE_ID,
  organizationId: ORG_ID,
  reportId: "order-volume-by-stage",
  cronExpression: "*/15 * * * *",
  timezone: "UTC",
  parametersTemplate: { from: "now-7d", to: "now" },
  nextRunAt: new Date("2026-05-28T09:00:00.000Z"),
});

interface PrismaFake {
  client: {
    organization: { findUnique: ReturnType<typeof vi.fn> };
    user: { findFirst: ReturnType<typeof vi.fn> };
    reportSchedule: { update: ReturnType<typeof vi.fn> };
  };
  updateCalls: Array<{ where: unknown; data: Record<string, unknown> }>;
}

function buildPrismaFake(
  input: {
    orgSlug?: string | null;
    actorUserId?: string | null;
  } = {}
): PrismaFake {
  const updateCalls: PrismaFake["updateCalls"] = [];
  const client = {
    organization: {
      findUnique: vi.fn(async () =>
        input.orgSlug === null ? null : { slug: input.orgSlug ?? "acme" }
      ),
    },
    user: {
      findFirst: vi.fn(async () =>
        input.actorUserId === null ? null : { id: input.actorUserId ?? SERVICE_USER_ID }
      ),
    },
    reportSchedule: {
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args);
        return { id: SCHEDULE_ID };
      }),
    },
  };
  return { client, updateCalls };
}

beforeEach(() => {
  executeCommandMock.mockClear();
  vi.mocked(claimDueReportSchedules).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReportScheduler tick — happy path", () => {
  it("dispatches RunReport per due schedule and advances nextRunAt", async () => {
    vi.mocked(claimDueReportSchedules).mockResolvedValue([DUE_ROW]);
    const fake = buildPrismaFake();
    const scheduler = createReportScheduler(
      // The fake exposes only the surface the scheduler uses.
      { client: fake.client as never, logger: logger.noopLogger },
      { batchSize: 25 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });

    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    const callArgs = executeCommandMock.mock.calls[0]!;
    const input = callArgs[1] as { reportId: string; parameters: Record<string, unknown> };
    expect(input.reportId).toBe("order-volume-by-stage");
    expect(input.parameters["from"]).toBeInstanceOf(Date);
    expect(input.parameters["to"]).toBeInstanceOf(Date);

    expect(fake.updateCalls).toHaveLength(1);
    const data = fake.updateCalls[0]!.data;
    expect(data["lastRunStatus"]).toBe("SUCCEEDED");
    expect(data["lastRunReportRunId"]).toBe("rr-1");
    expect(data["lastRunErrorCode"]).toBeNull();
    expect(data["nextRunAt"]).toBeInstanceOf(Date);
    // nextRunAt MUST advance past the row's previous nextRunAt
    expect((data["nextRunAt"] as Date).getTime()).toBeGreaterThan(DUE_ROW.nextRunAt.getTime());
    expect(data["runCount"]).toEqual({ increment: 1 });
  });
});

describe("ReportScheduler tick — graceful skip when service user missing", () => {
  it("marks SKIPPED with ACTOR_NOT_FOUND and still advances nextRunAt", async () => {
    vi.mocked(claimDueReportSchedules).mockResolvedValue([DUE_ROW]);
    const fake = buildPrismaFake({ actorUserId: null });
    const scheduler = createReportScheduler(
      { client: fake.client as never, logger: logger.noopLogger },
      { batchSize: 25 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 0, skipped: 1 });

    expect(executeCommandMock).not.toHaveBeenCalled();
    const data = fake.updateCalls[0]!.data;
    expect(data["lastRunStatus"]).toBe("SKIPPED");
    expect(data["lastRunErrorCode"]).toBe("ACTOR_NOT_FOUND");
    expect(data["lastRunReportRunId"]).toBeNull();
    // Still advances so we don't infinite-loop a config error
    expect(data["nextRunAt"]).toBeInstanceOf(Date);
  });
});

describe("ReportScheduler tick — RunReport failure isolation", () => {
  it("marks FAILED and continues processing subsequent rows", async () => {
    const row2 = { ...DUE_ROW, id: "sch-2", reportId: "sla-breach-report" };
    vi.mocked(claimDueReportSchedules).mockResolvedValue([DUE_ROW, row2]);
    const fake = buildPrismaFake();
    // First call throws; second succeeds.
    executeCommandMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const scheduler = createReportScheduler(
      { client: fake.client as never, logger: logger.noopLogger },
      { batchSize: 25 }
    );

    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1, skipped: 0 });

    expect(fake.updateCalls).toHaveLength(2);
    expect(fake.updateCalls[0]!.data["lastRunStatus"]).toBe("FAILED");
    expect(fake.updateCalls[0]!.data["lastRunErrorCode"]).toBe("REPORT_SCHEDULER_DISPATCH_FAILED");
    expect(fake.updateCalls[1]!.data["lastRunStatus"]).toBe("SUCCEEDED");
  });
});

describe("ReportScheduler tick — empty batch", () => {
  it("returns zeros when nothing is due", async () => {
    vi.mocked(claimDueReportSchedules).mockResolvedValue([]);
    const fake = buildPrismaFake();
    const scheduler = createReportScheduler(
      { client: fake.client as never, logger: logger.noopLogger },
      { batchSize: 25 }
    );
    const result = await scheduler.tick();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(fake.updateCalls).toHaveLength(0);
  });
});
