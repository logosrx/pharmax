// ConfirmVialLabelPrint contract tests — workstation agent callback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { PrintJobStatus, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  ConfirmVialLabelPrint,
  PRINT_JOB_NOT_CONFIRMABLE,
  PRINT_JOB_NOT_FOUND,
} from "./confirm-vial-label-print.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const PRINT_JOB_ID = "00000000-0000-4000-8000-0000000000cc";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const WORKSTATION_ID = "00000000-0000-4000-8000-0000000000ws";

const labelGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.LABELS_CONFIRM_PRINT]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    workstationId: WORKSTATION_ID,
    ...overrides,
  });
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  printJob?: Record<string, unknown> | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const printJob =
    overrides.printJob === undefined
      ? {
          id: PRINT_JOB_ID,
          status: PrintJobStatus.PENDING,
          orderId: ORDER_ID,
          orderLineId: ORDER_LINE_ID,
          workstationId: WORKSTATION_ID,
        }
      : overrides.printJob;

  const tx = {
    printJob: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "findFirst", args });
        return printJob;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "update", args });
        return { id: PRINT_JOB_ID };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return { sequenceNumber: 5 };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-6" };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        return {
          organizationId: ORG_ID,
          latestHash: Buffer.alloc(32),
          latestSeq: 1n,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        calls.push({
          table: "$executeRaw",
          op: "set_config",
          args: { sql: template.join("?"), values: [...values] },
        });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T14:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: labelGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ConfirmVialLabelPrint — happy path", () => {
  it("marks print job COMPLETED and emits labels.vial_print.completed.v1", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ConfirmVialLabelPrint,
        { printJobId: PRINT_JOB_ID, status: "COMPLETED" },
        { idempotencyKey: "confirm-1" }
      )
    );

    expect(out).toEqual({ printJobId: PRINT_JOB_ID, status: "COMPLETED" });

    const updateData = (
      callsOf(fake.calls, "printJob", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateData).toMatchObject({
      status: PrintJobStatus.COMPLETED,
      failureReason: null,
    });
    expect(updateData["completedAt"]).toEqual(new Date("2026-05-23T14:00:00.000Z"));

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({
      eventType: "labels.vial_print.completed.v1",
      aggregateId: PRINT_JOB_ID,
    });
  });

  it("FAILED requires failureReason and emits labels.vial_print.failed.v1", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ConfirmVialLabelPrint,
        {
          printJobId: PRINT_JOB_ID,
          status: "FAILED",
          failureReason: "Printer offline",
        },
        { idempotencyKey: "confirm-fail" }
      )
    );

    expect(out.status).toBe("FAILED");

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({ eventType: "labels.vial_print.failed.v1" });
  });
});

describe("ConfirmVialLabelPrint — guards", () => {
  it("print job missing → PRINT_JOB_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ printJob: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ConfirmVialLabelPrint,
          { printJobId: PRINT_JOB_ID, status: "COMPLETED" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: PRINT_JOB_NOT_FOUND });
    });
  });

  it("already COMPLETED → PRINT_JOB_NOT_CONFIRMABLE", async () => {
    const fake = buildPrismaFake({
      printJob: {
        id: PRINT_JOB_ID,
        status: PrintJobStatus.COMPLETED,
        orderId: ORDER_ID,
        orderLineId: ORDER_LINE_ID,
        workstationId: WORKSTATION_ID,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ConfirmVialLabelPrint,
          { printJobId: PRINT_JOB_ID, status: "COMPLETED" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: PRINT_JOB_NOT_CONFIRMABLE });
    });
  });

  it("workstation mismatch → WORKSTATION_MISMATCH", async () => {
    const fake = buildPrismaFake({
      printJob: {
        id: PRINT_JOB_ID,
        status: PrintJobStatus.PENDING,
        orderId: ORDER_ID,
        orderLineId: ORDER_LINE_ID,
        workstationId: "other-ws",
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ConfirmVialLabelPrint,
          { printJobId: PRINT_JOB_ID, status: "COMPLETED" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "WORKSTATION_MISMATCH" });
    });
  });

  it("FAILED without failureReason → COMMAND_INPUT_INVALID", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ConfirmVialLabelPrint,
          { printJobId: PRINT_JOB_ID, status: "FAILED" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "printJob", "update")).toHaveLength(0);
  });

  it("workstation required but missing → COMMAND_WORKSTATION_REQUIRED", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(
      buildTenancyContext({
        organizationId: ORG_ID,
        actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
      }),
      async () => {
        await expect(
          executeCommand(
            ConfirmVialLabelPrint,
            { printJobId: PRINT_JOB_ID, status: "COMPLETED" },
            { idempotencyKey: "k" }
          )
        ).rejects.toMatchObject({ code: "COMMAND_WORKSTATION_REQUIRED" });
      }
    );
  });
});
