// Tests for the scheduled-report notification outbox handler.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channelSendMock = vi.hoisted(() =>
  vi.fn(async () => ({
    deliveryId: "del-1",
    status: "delivered" as const,
    recipientKind: "email" as const,
    sentAt: new Date(),
  }))
);

const getNotificationChannelMock = vi.hoisted(() =>
  vi.fn(() => ({
    metadata: {
      name: "fake",
      supportedRecipientKinds: ["email"] as const,
      phiCapable: false,
    },
    send: channelSendMock,
  }))
);

vi.mock("@pharmax/notifications", async () => {
  type NotificationsModule = typeof NotificationsModuleType;
  const actual = (await vi.importActual("@pharmax/notifications")) as NotificationsModule;
  return {
    ...actual,
    getNotificationChannel: getNotificationChannelMock,
  };
});

import { logger as loggerNs, errors } from "@pharmax/platform-core";
import { NOTIFICATIONS_NOT_CONFIGURED } from "@pharmax/notifications";
import type * as NotificationsModuleType from "@pharmax/notifications";

import { createNotifyOnReportRunCompletedHandler } from "./notify-on-report-run-completed.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

const ORG_ID = "11111111-1111-1111-1111-000000000001";
const SCHEDULE_ID = "22222222-2222-2222-2222-000000000001";
const REPORT_RUN_ID = "33333333-3333-3333-3333-000000000001";

function buildRow(overrides: { payload?: Record<string, unknown> } = {}): ClaimedOutboxEventRow {
  return Object.freeze({
    id: "outbox-1",
    organizationId: ORG_ID,
    eventType: "reporting.run.completed.v1",
    aggregateType: "ReportRun",
    aggregateId: REPORT_RUN_ID,
    payload: {
      organizationId: ORG_ID,
      reportRunId: REPORT_RUN_ID,
      reportId: "order-volume-by-stage",
      reportVersion: 1,
      rowCount: 100,
      aggregates: { totalShipped: 100 },
      windowFrom: "2026-05-21T00:00:00.000Z",
      windowTo: "2026-05-28T00:00:00.000Z",
      generatedAt: "2026-05-28T13:00:00.000Z",
      runByUserId: "44444444-4444-4444-4444-000000000001",
      runViaScheduleId: SCHEDULE_ID,
      ...(overrides.payload ?? {}),
    },
    status: "PENDING",
    attempts: 1,
    lastError: null,
    nextAttemptAt: null,
    dispatchedAt: null,
    createdAt: new Date("2026-05-28T13:00:00.000Z"),
  });
}

/**
 * Builds a Prisma surface fake covering both `reportSchedule.findUnique`
 * (the recipient lookup) and `reportRun.findUnique` (the downloadLink
 * resolution). Accepts EITHER a plain schedule object (matches the
 * original signature so the bulk of the suite stays untouched) or
 * an options bag with an explicit `reportRun` override.
 */
function buildPrismaFake(input: unknown) {
  const isOptionsBag =
    input !== null && typeof input === "object" && "schedule" in (input as object);
  const opts: { schedule: unknown; reportRun?: unknown } = isOptionsBag
    ? (input as { schedule: unknown; reportRun?: unknown })
    : { schedule: input };
  return {
    reportSchedule: {
      findUnique: vi.fn(async () => opts.schedule),
    },
    reportRun: {
      findUnique: vi.fn(async () => opts.reportRun ?? null),
    },
  };
}

const HANDLER_CTX = { logger: loggerNs.noopLogger, receivedAt: new Date() };

beforeEach(() => {
  channelSendMock.mockClear();
  getNotificationChannelMock.mockReset();
  getNotificationChannelMock.mockReturnValue({
    metadata: { name: "fake", supportedRecipientKinds: ["email"], phiCapable: false },
    send: channelSendMock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notify-on-report-run-completed — happy path", () => {
  it("sends one email per recipient and projects context", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "Weekly volume",
      recipients: ["a@acme.test", "b@acme.test"],
      notifyOn: "ALWAYS",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test/",
    });
    await handler(buildRow(), HANDLER_CTX);

    expect(channelSendMock).toHaveBeenCalledTimes(2);
    const firstCallRaw = channelSendMock.mock.calls[0] as ReadonlyArray<unknown>;
    const firstCall = firstCallRaw[0] as {
      to: { address: string };
      template: string;
      context: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(firstCall.to.address).toBe("a@acme.test");
    expect(firstCall.template).toBe("REPORT_RUN_COMPLETED_V1");
    expect(firstCall.context["scheduleName"]).toBe("Weekly volume");
    expect(firstCall.context["dashboardLink"]).toBe(
      "https://ops.pharmax.test/ops/reports/order-volume-by-stage"
    );
    expect(firstCall.idempotencyKey).toBe(`report-run-notify:${REPORT_RUN_ID}:a@acme.test`);
  });
});

describe("notify-on-report-run-completed — skip gates", () => {
  it("skips when runViaScheduleId is null (operator-initiated)", async () => {
    const fake = buildPrismaFake(null);
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow({ payload: { runViaScheduleId: null } }), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
    expect(fake.reportSchedule.findUnique).not.toHaveBeenCalled();
  });

  it("skips when notification channel is not configured", async () => {
    getNotificationChannelMock.mockImplementation(() => {
      throw new errors.InternalError({
        code: NOTIFICATIONS_NOT_CONFIGURED,
        message: "no channel",
      });
    });
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["a@acme.test"],
      notifyOn: "ALWAYS",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
  });

  it("skips when schedule was deleted between dispatch and notify", async () => {
    const fake = buildPrismaFake(null);
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
  });

  it("skips a SUCCEEDED run when notifyOn is FAILURE_ONLY", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["a@acme.test"],
      notifyOn: "FAILURE_ONLY",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow({ payload: { runStatus: "SUCCEEDED" } }), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
  });

  it("sends a FAILED run when notifyOn is FAILURE_ONLY", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["a@acme.test"],
      notifyOn: "FAILURE_ONLY",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow({ payload: { runStatus: "FAILED" } }), HANDLER_CTX);
    expect(channelSendMock).toHaveBeenCalledTimes(1);
  });

  it("skips when notifyOn is NEVER regardless of outcome", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["a@acme.test"],
      notifyOn: "NEVER",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow({ payload: { runStatus: "FAILED" } }), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
  });

  it("skips when recipients list is empty", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: [],
      notifyOn: "ALWAYS",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
  });
});

describe("notify-on-report-run-completed — partial failure isolation", () => {
  it("logs per-recipient failures and continues", async () => {
    let callCount = 0;
    channelSendMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new errors.InternalError({
          code: "NOTIFICATION_TRANSPORT_ERROR",
          message: "5xx",
        });
      }
      return {
        deliveryId: "del-x",
        status: "delivered" as const,
        recipientKind: "email" as const,
        sentAt: new Date(),
      };
    });
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["bad@x.test", "good@x.test"],
      notifyOn: "ALWAYS",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await expect(handler(buildRow(), HANDLER_CTX)).resolves.toBeUndefined();
    expect(channelSendMock).toHaveBeenCalledTimes(2);
  });

  it("throws NOTIFICATION_FANOUT_TOTAL_FAILURE when ALL recipients fail", async () => {
    channelSendMock.mockImplementation(async () => {
      throw new errors.InternalError({
        code: "NOTIFICATION_TRANSPORT_ERROR",
        message: "outage",
      });
    });
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["a@x.test", "b@x.test"],
      notifyOn: "ALWAYS",
      organizationId: ORG_ID,
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await expect(handler(buildRow(), HANDLER_CTX)).rejects.toMatchObject({
      code: "NOTIFICATION_FANOUT_TOTAL_FAILURE",
    });
  });
});

describe("notify-on-report-run-completed — downloadLink", () => {
  it("includes downloadLink when the report_run row has a persisted CSV", async () => {
    const fake = buildPrismaFake({
      schedule: {
        id: SCHEDULE_ID,
        name: "X",
        recipients: ["a@acme.test"],
        notifyOn: "ALWAYS",
        organizationId: ORG_ID,
      },
      reportRun: { organizationId: ORG_ID, csvObjectKey: "reports/o/y/m/d/r.csv" },
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    expect(channelSendMock).toHaveBeenCalledTimes(1);
    const callRaw = channelSendMock.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callRaw[0] as { context: Record<string, unknown> };
    expect(call.context["downloadLink"]).toBe(
      `https://ops.pharmax.test/api/ops/reports/runs/${encodeURIComponent(REPORT_RUN_ID)}/download`
    );
  });

  it("omits downloadLink when no CSV has been persisted", async () => {
    const fake = buildPrismaFake({
      schedule: {
        id: SCHEDULE_ID,
        name: "X",
        recipients: ["a@acme.test"],
        notifyOn: "ALWAYS",
        organizationId: ORG_ID,
      },
      reportRun: { organizationId: ORG_ID, csvObjectKey: null },
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    const callRaw = channelSendMock.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callRaw[0] as { context: Record<string, unknown> };
    expect(call.context["downloadLink"]).toBeUndefined();
  });

  it("omits downloadLink when run row org doesn't match (defense in depth)", async () => {
    const fake = buildPrismaFake({
      schedule: {
        id: SCHEDULE_ID,
        name: "X",
        recipients: ["a@acme.test"],
        notifyOn: "ALWAYS",
        organizationId: ORG_ID,
      },
      reportRun: {
        organizationId: "99999999-9999-9999-9999-999999999999",
        csvObjectKey: "reports/o/y/m/d/r.csv",
      },
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    const callRaw = channelSendMock.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callRaw[0] as { context: Record<string, unknown> };
    expect(call.context["downloadLink"]).toBeUndefined();
  });
});

describe("notify-on-report-run-completed — defense in depth", () => {
  it("drops the row on schedule/payload org mismatch", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      name: "X",
      recipients: ["a@acme.test"],
      notifyOn: "ALWAYS",
      organizationId: "99999999-9999-9999-9999-999999999999",
    });
    const handler = createNotifyOnReportRunCompletedHandler({
      client: fake as never,
      opsConsoleBaseUrl: "https://ops.pharmax.test",
    });
    await handler(buildRow(), HANDLER_CTX);
    expect(channelSendMock).not.toHaveBeenCalled();
  });
});
