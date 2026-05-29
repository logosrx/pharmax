// CreateReportSchedule contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { Prisma, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { CreateReportSchedule } from "./create-report-schedule.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";

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

function buildPrismaFake(
  input: {
    createThrows?: Error;
    createResult?: { id: string };
  } = {}
) {
  const calls: FakeCall[] = [];
  const tx = {
    reportSchedule: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "reportSchedule", op: "create", args });
        if (input.createThrows !== undefined) throw input.createThrows;
        return input.createResult ?? { id: "rs-1" };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
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
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
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
  return { client, calls };
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

const validInput = {
  name: "Weekly volume Mondays",
  reportId: "order-volume-by-stage",
  cronExpression: "0 9 * * 1",
  timezone: "America/New_York",
  parametersTemplate: { from: "now-7d", to: "now" },
};

describe("CreateReportSchedule — happy path", () => {
  it("validates cron + template, persists ACTIVE row, writes audit + outbox", async () => {
    const fake = buildPrismaFake({ createResult: { id: "rs-fresh" } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateReportSchedule, validInput, { idempotencyKey: "crs-1" })
    );

    expect(out.reportScheduleId).toBe("rs-fresh");
    expect(out.reportId).toBe("order-volume-by-stage");
    expect(out.status).toBe("ACTIVE");
    // 9am Mon NYC = 13:00 UTC; first Monday after 2026-05-28 = 2026-06-01
    expect(out.nextRunAt).toBe("2026-06-01T13:00:00.000Z");

    const create = fake.calls.find((c) => c.table === "reportSchedule" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["reportId"]).toBe("order-volume-by-stage");
    expect(data["cronExpression"]).toBe("0 9 * * 1");
    expect(data["timezone"]).toBe("America/New_York");
    expect(data["status"]).toBe("ACTIVE");
    expect(data["createdByUserId"]).toBe(USER_ID);

    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect((audit!.args as { data: { action: string } }).data.action).toBe(
      "report.schedule.created"
    );

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const payload = (outbox!.args as { data: ReadonlyArray<{ eventType: string }> }).data[0]!;
    expect(payload.eventType).toBe("reporting.schedule.created.v1");
  });
});

describe("CreateReportSchedule — guards", () => {
  it("throws REPORT_NOT_FOUND for an unknown report id", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateReportSchedule,
          { ...validInput, reportId: "no-such-report" },
          { idempotencyKey: "crs-2" }
        )
      )
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("throws CRON_EXPRESSION_INVALID for a malformed cron expression", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateReportSchedule,
          { ...validInput, cronExpression: "this is not cron" },
          { idempotencyKey: "crs-3" }
        )
      )
    ).rejects.toMatchObject({ code: "CRON_EXPRESSION_INVALID" });
  });

  it("throws SCHEDULE_TEMPLATE_INVALID when template fails the report's parameter schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    // order-volume-by-stage requires from <= to. Force a backwards
    // resolution to trigger the schema's refine failure.
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateReportSchedule,
          {
            ...validInput,
            parametersTemplate: {
              from: "2099-12-31",
              to: "2020-01-01",
            },
          },
          { idempotencyKey: "crs-4" }
        )
      )
    ).rejects.toMatchObject({ code: "SCHEDULE_TEMPLATE_INVALID" });
  });

  it("translates P2002 to SCHEDULE_NAME_TAKEN", async () => {
    const err = Object.assign(new Error("dup"), {
      code: "P2002",
      clientVersion: "test",
      meta: {},
      name: "PrismaClientKnownRequestError",
    });
    Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
    const fake = buildPrismaFake({ createThrows: err });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateReportSchedule, validInput, { idempotencyKey: "crs-5" })
      )
    ).rejects.toMatchObject({ code: "SCHEDULE_NAME_TAKEN" });
  });
});

describe("CreateReportSchedule — RBAC", () => {
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
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateReportSchedule, validInput, { idempotencyKey: "crs-6" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
