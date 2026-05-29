// DisableReportSchedule contract tests.

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

import { DisableReportSchedule } from "./disable-report-schedule.js";

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

function buildPrismaFake(existing: unknown) {
  const calls: FakeCall[] = [];
  const tx = {
    reportSchedule: {
      findFirst: vi.fn(async () => existing),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "reportSchedule", op: "update", args });
        return { id: SCHEDULE_ID };
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

describe("DisableReportSchedule — happy path", () => {
  it("flips ACTIVE → DISABLED, writes audit + outbox", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      reportId: "order-volume-by-stage",
      name: "Weekly",
      status: "ACTIVE",
    });
    configureBus(fake.client);
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        DisableReportSchedule,
        { reportScheduleId: SCHEDULE_ID },
        { idempotencyKey: "drs-1" }
      )
    );
    expect(out.wasAlreadyDisabled).toBe(false);
    const upd = fake.calls.find((c) => c.table === "reportSchedule" && c.op === "update");
    expect((upd!.args as { data: { status: string } }).data.status).toBe("DISABLED");
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect((audit!.args as { data: { action: string } }).data.action).toBe(
      "report.schedule.disabled"
    );
    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    expect(outbox).toBeDefined();
  });
});

describe("DisableReportSchedule — idempotent re-disable", () => {
  it("audits as 'disable_redundant' with no outbox emit and no update", async () => {
    const fake = buildPrismaFake({
      id: SCHEDULE_ID,
      reportId: "order-volume-by-stage",
      name: "Weekly",
      status: "DISABLED",
    });
    configureBus(fake.client);
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        DisableReportSchedule,
        { reportScheduleId: SCHEDULE_ID },
        { idempotencyKey: "drs-2" }
      )
    );
    expect(out.wasAlreadyDisabled).toBe(true);
    const upd = fake.calls.find((c) => c.table === "reportSchedule" && c.op === "update");
    expect(upd).toBeUndefined();
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect((audit!.args as { data: { action: string } }).data.action).toBe(
      "report.schedule.disable_redundant"
    );
    // No outbox row on the no-op path
    const outboxRow = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    if (outboxRow !== undefined) {
      // The bus's outbox createMany may still fire with zero items
      // — assert the row count is 0 if so.
      const data = (outboxRow.args as { data: ReadonlyArray<unknown> }).data;
      expect(data.length).toBe(0);
    }
  });
});

describe("DisableReportSchedule — not-found", () => {
  it("throws REPORT_SCHEDULE_NOT_FOUND", async () => {
    const fake = buildPrismaFake(null);
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          DisableReportSchedule,
          { reportScheduleId: SCHEDULE_ID },
          { idempotencyKey: "drs-3" }
        )
      )
    ).rejects.toMatchObject({ code: "REPORT_SCHEDULE_NOT_FOUND" });
  });
});
