// UpdateReportSchedule contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { UpdateReportSchedule, REPORT_SCHEDULE_NOT_FOUND } from "./update-report-schedule.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000077";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.REPORTS_MANAGE_SCHEDULE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function existingSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    reportId: "order-volume-by-stage",
    name: "Weekly volume",
    cronExpression: "0 6 * * 1",
    timezone: "America/New_York",
    parametersTemplate: { from: "now-7d", to: "now" },
    status: "ACTIVE",
    nextRunAt: new Date("2026-06-01T10:00:00.000Z"),
    recipients: ["reports@example.com"],
    notifyOn: "ALWAYS",
    ...overrides,
  };
}

function buildPrismaFake(existing: unknown) {
  const calls: FakeCall[] = [];
  const tx = {
    reportSchedule: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "reportSchedule", op: "findFirst", args });
        return existing;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "reportSchedule", op: "update", args });
        return { id: SCHEDULE_ID };
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
  };
  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { client, calls, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-28T15:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

function updateData(calls: ReadonlyArray<FakeCall>) {
  const upd = calls.find((c) => c.table === "reportSchedule" && c.op === "update");
  return (upd?.args as { data: Record<string, unknown> } | undefined)?.data;
}

describe("UpdateReportSchedule — happy path", () => {
  it("applies a rename and re-anchors nextRunAt on the new cron", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        { reportScheduleId: SCHEDULE_ID, name: "Monday volume", cronExpression: "0 9 * * 1" },
        { idempotencyKey: "urs-1" }
      )
    );

    expect(out.fieldsChanged).toEqual(["name", "cronExpression"]);
    // Anchored at the update clock, not at the old nextRunAt:
    // 9am Mon NYC = 13:00 UTC, first Monday after 2026-05-28.
    expect(out.nextRunAt).toBe("2026-06-01T13:00:00.000Z");

    const data = updateData(fake.calls)!;
    expect(data["name"]).toBe("Monday volume");
    expect(data["cronExpression"]).toBe("0 9 * * 1");
    expect(data["nextRunAt"]).toEqual(new Date("2026-06-01T13:00:00.000Z"));
  });

  it("omits fields the operator sent unchanged", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        { reportScheduleId: SCHEDULE_ID, name: "Weekly volume", status: "PAUSED" },
        { idempotencyKey: "urs-2" }
      )
    );

    expect(out.fieldsChanged).toEqual(["status"]);
    expect(updateData(fake.calls)).toEqual({ status: "PAUSED" });
  });

  it("recomputes nextRunAt when only the timezone moves", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        { reportScheduleId: SCHEDULE_ID, timezone: "America/Los_Angeles" },
        { idempotencyKey: "urs-3" }
      )
    );

    // Same 6am cron, three hours further west.
    expect(out.fieldsChanged).toEqual(["timezone"]);
    expect(out.nextRunAt).toBe("2026-06-01T13:00:00.000Z");
  });

  it("lowercases and de-duplicates recipients", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        {
          reportScheduleId: SCHEDULE_ID,
          recipients: ["Ops@Example.com", "ops@example.com"],
        },
        { idempotencyKey: "urs-4" }
      )
    );

    expect(out.fieldsChanged).toEqual(["recipients"]);
    expect(updateData(fake.calls)!["recipients"]).toEqual(["ops@example.com"]);
  });

  it("writes audit and outbox describing what changed", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        { reportScheduleId: SCHEDULE_ID, status: "DISABLED" },
        { idempotencyKey: "urs-5" }
      )
    );

    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const auditData = (
      audit!.args as { data: { action: string; metadata: Record<string, unknown> } }
    ).data;
    expect(auditData.action).toBe("report.schedule.updated");
    expect(auditData.metadata["fieldsChanged"]).toEqual(["status"]);
    expect(auditData.metadata["newStatus"]).toBe("DISABLED");

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows[0]!["eventType"]).toBe("reporting.schedule.updated.v1");
    expect((rows[0]!["payload"] as Record<string, unknown>)["organizationId"]).toBe(ORG_ID);
  });
});

describe("UpdateReportSchedule — tenancy", () => {
  it("scopes the lookup to the caller's organization", async () => {
    // Without this the id alone would address any tenant's
    // schedule, and the update below would follow it.
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        { reportScheduleId: SCHEDULE_ID, status: "PAUSED" },
        { idempotencyKey: "urs-6" }
      )
    );

    const read = fake.calls.find((c) => c.table === "reportSchedule" && c.op === "findFirst");
    expect((read!.args as { where: Record<string, unknown> }).where).toEqual({
      id: SCHEDULE_ID,
      organizationId: ORG_ID,
    });
  });

  it("reports a schedule outside the org as not found and changes nothing", async () => {
    // The org-scoped read returns nothing, so a foreign id is
    // indistinguishable from one that never existed.
    const fake = buildPrismaFake(null);
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          { reportScheduleId: SCHEDULE_ID, status: "DISABLED" },
          { idempotencyKey: "urs-7" }
        )
      )
    ).rejects.toMatchObject({ code: REPORT_SCHEDULE_NOT_FOUND });
    expect(fake.tx.reportSchedule.update).not.toHaveBeenCalled();
  });
});

describe("UpdateReportSchedule — validation", () => {
  it("rejects a malformed cron expression", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          { reportScheduleId: SCHEDULE_ID, cronExpression: "this is not cron" },
          { idempotencyKey: "urs-8" }
        )
      )
    ).rejects.toMatchObject({ code: "CRON_EXPRESSION_INVALID" });
    expect(fake.tx.reportSchedule.update).not.toHaveBeenCalled();
  });

  it("rejects a template that fails the report's own parameter schema", async () => {
    // order-volume-by-stage requires from <= to; the dry run is
    // what stops a schedule that would fail every worker tick.
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          {
            reportScheduleId: SCHEDULE_ID,
            parametersTemplate: { from: "2099-12-31", to: "2020-01-01" },
          },
          { idempotencyKey: "urs-9" }
        )
      )
    ).rejects.toMatchObject({ code: "SCHEDULE_TEMPLATE_INVALID" });
    expect(fake.tx.reportSchedule.update).not.toHaveBeenCalled();
  });

  it("accepts a template whose placeholders resolve inside the schema", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        {
          reportScheduleId: SCHEDULE_ID,
          parametersTemplate: { from: "now-30d", to: "now" },
        },
        { idempotencyKey: "urs-10" }
      )
    );

    expect(out.fieldsChanged).toEqual(["parametersTemplate"]);
    expect(updateData(fake.calls)!["parametersTemplate"]).toEqual({
      from: "now-30d",
      to: "now",
    });
  });

  it("requires at least one editable field", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          { reportScheduleId: SCHEDULE_ID },
          { idempotencyKey: "urs-11" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(fake.tx.reportSchedule.findFirst).not.toHaveBeenCalled();
  });

  it("refuses to change the report the schedule runs", async () => {
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          { reportScheduleId: SCHEDULE_ID, reportId: "sla-breach-report" } as never,
          { idempotencyKey: "urs-12" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
  });
});

describe("UpdateReportSchedule — de-registered report", () => {
  it("still allows a status-only edit so a stale schedule can be disabled", async () => {
    const fake = buildPrismaFake(existingSchedule({ reportId: "retired-report" }));
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateReportSchedule,
        { reportScheduleId: SCHEDULE_ID, status: "DISABLED" },
        { idempotencyKey: "urs-13" }
      )
    );

    expect(out.fieldsChanged).toEqual(["status"]);
    expect(updateData(fake.calls)).toEqual({ status: "DISABLED" });
  });

  it("refuses a content edit it can no longer validate", async () => {
    const fake = buildPrismaFake(existingSchedule({ reportId: "retired-report" }));
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          { reportScheduleId: SCHEDULE_ID, parametersTemplate: { from: "now-7d", to: "now" } },
          { idempotencyKey: "urs-14" }
        )
      )
    ).rejects.toMatchObject({ code: "REPORT_DEFINITION_MISSING" });
    expect(fake.tx.reportSchedule.update).not.toHaveBeenCalled();
  });
});

describe("UpdateReportSchedule — RBAC", () => {
  it("denies without reports.manage_schedule", async () => {
    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.REPORTS_RUN]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake(existingSchedule());
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateReportSchedule,
          { reportScheduleId: SCHEDULE_ID, status: "DISABLED" },
          { idempotencyKey: "urs-15" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.reportSchedule.update).not.toHaveBeenCalled();
  });
});
