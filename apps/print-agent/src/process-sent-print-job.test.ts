import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { PrintJobStatus, RoleScope } from "@pharmax/database";
import { clock, logger as loggerNs } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext } from "@pharmax/tenancy";

import { processSentPrintJob } from "./process-sent-print-job.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTATION_ID = "00000000-0000-4000-8000-0000000000ws";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const PRINT_JOB_ID = "00000000-0000-4000-8000-0000000000cc";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.LABELS_CONFIRM_PRINT]),
  },
];

function tenancy() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    workstationId: WORKSTATION_ID,
  });
}

function buildClient(status: PrintJobStatus) {
  const printJobUpdate = vi.fn(async () => ({ id: PRINT_JOB_ID }));

  const tx = {
    printJob: {
      findFirst: vi.fn(async () => ({
        id: PRINT_JOB_ID,
        status,
        orderId: "order-1",
        orderLineId: "line-1",
        workstationId: WORKSTATION_ID,
      })),
      update: printJobUpdate,
    },
    orderEvent: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "oe-1" })),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: {
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: {
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, printJobUpdate };
}

describe("processSentPrintJob", () => {
  beforeEach(() => {
    resetCommandBusConfigurationForTests();
    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
    });
  });

  afterEach(() => {
    resetCommandBusConfigurationForTests();
    resetRbacConfigurationForTests();
  });

  it("sends ZPL then confirms COMPLETED", async () => {
    const transport = { send: vi.fn(async () => undefined) };
    const { client, printJobUpdate } = buildClient(PrintJobStatus.SENT);

    configureCommandBus({
      prisma: client as never,
      clock: clock.systemClock,
      logger: loggerNs.noopLogger,
    });

    const result = await processSentPrintJob(
      {
        client: client as never,
        transport,
        logger: loggerNs.noopLogger,
        organizationId: ORG_ID,
        workstationId: WORKSTATION_ID,
        buildTenancy: tenancy,
      },
      {
        id: PRINT_JOB_ID,
        renderedZpl: "^XA^XZ",
        printerId: "printer-1",
        orderId: "order-1",
        orderLineId: "line-1",
      }
    );

    expect(result).toEqual({
      processed: true,
      printJobId: PRINT_JOB_ID,
      outcome: "completed",
    });
    expect(transport.send).toHaveBeenCalledWith("^XA^XZ");
    expect(printJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PrintJobStatus.COMPLETED }),
      })
    );
  });

  it("confirms FAILED when transport throws", async () => {
    const transport = {
      send: vi.fn(async () => {
        throw new Error("printer offline");
      }),
    };
    const { client, printJobUpdate } = buildClient(PrintJobStatus.SENT);

    configureCommandBus({
      prisma: client as never,
      clock: clock.systemClock,
      logger: loggerNs.noopLogger,
    });

    const result = await processSentPrintJob(
      {
        client: client as never,
        transport,
        logger: loggerNs.noopLogger,
        organizationId: ORG_ID,
        workstationId: WORKSTATION_ID,
        buildTenancy: tenancy,
      },
      {
        id: PRINT_JOB_ID,
        renderedZpl: "^XA^XZ",
        printerId: "printer-1",
        orderId: "order-1",
        orderLineId: "line-1",
      }
    );

    expect(result.outcome).toBe("failed");
    expect(printJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PrintJobStatus.FAILED,
          failureReason: "printer offline",
        }),
      })
    );
  });
});
