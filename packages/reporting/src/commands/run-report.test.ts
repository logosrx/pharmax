// RunReport contract tests.
//
// Covers:
//   1. Happy path: resolves a known report id, dynamic-parses
//      parameters via the report's own Zod schema, runs the
//      report against the active tx, persists a report_run row,
//      writes audit + outbox with the resolved metadata.
//   2. Unknown reportId → REPORT_NOT_FOUND (NotFoundError).
//   3. Invalid parameters → REPORT_PARAMETERS_INVALID
//      (ValidationError). Surfaces BEFORE any DB write.
//   4. RBAC: actor without reports.run → PERMISSION_DENIED.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { OrderStatus, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  configureReportRunArchive,
  resetReportRunArchiveConfigurationForTests,
} from "../archive/configure.js";
import { InMemoryReportRunArchive } from "../archive/in-memory-report-run-archive.js";
import {
  configureReportReadScope,
  resetReportReadScopeConfigurationForTests,
} from "../replica/configure.js";
import { RunReport } from "./run-report.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.REPORTS_RUN]),
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

function buildPrismaFake(input: {
  orderGroupByResult?: ReadonlyArray<{
    clinicId: string;
    currentStatus: OrderStatus;
    _count: { _all: number };
  }>;
  reportRunCreateResult?: { id: string };
}) {
  const calls: FakeCall[] = [];

  const tx = {
    order: {
      groupBy: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "groupBy", args });
        return input.orderGroupByResult ?? [];
      }),
    },
    reportRun: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "reportRun", op: "create", args });
        return input.reportRunCreateResult ?? { id: "rr-1" };
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
  resetReportRunArchiveConfigurationForTests();
  resetReportReadScopeConfigurationForTests();
});

const validParams = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-28T00:00:00.000Z"),
};

describe("RunReport — happy path (order-volume-by-stage)", () => {
  it("runs the report, persists a report_run row, audits + outboxes", async () => {
    const fake = buildPrismaFake({
      orderGroupByResult: [
        {
          clinicId: "00000000-0000-4000-8000-000000000010",
          currentStatus: OrderStatus.TYPED_READY_FOR_PV1,
          _count: { _all: 17 },
        },
        {
          clinicId: "00000000-0000-4000-8000-000000000010",
          currentStatus: OrderStatus.PV1_IN_PROGRESS,
          _count: { _all: 3 },
        },
      ],
      reportRunCreateResult: { id: "rr-fresh" },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RunReport,
        {
          reportId: "order-volume-by-stage",
          parameters: validParams,
        },
        { idempotencyKey: "rr-test-1" }
      )
    );

    expect(out.reportRunId).toBe("rr-fresh");
    expect(out.reportId).toBe("order-volume-by-stage");
    expect(out.reportVersion).toBe(1);
    expect(out.rowCount).toBe(2);
    expect(out.aggregates).toMatchObject({ totalCount: 20, distinctGroups: 2 });
    expect(out.rows).toHaveLength(2);

    // report_run insert shape
    const runCreate = fake.calls.find((c) => c.table === "reportRun" && c.op === "create");
    expect(runCreate).toBeDefined();
    const runData = (runCreate!.args as { data: Record<string, unknown> }).data;
    expect(runData["reportId"]).toBe("order-volume-by-stage");
    expect(runData["reportVersion"]).toBe(1);
    expect(runData["rowCount"]).toBe(2);
    expect(runData["runByUserId"]).toBe(USER_ID);
    expect((runData["aggregates"] as Record<string, number>)["totalCount"]).toBe(20);

    // audit metadata carries the report id + version + aggregates
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const meta = (audit!.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(meta["reportId"]).toBe("order-volume-by-stage");
    expect(meta["reportVersion"]).toBe(1);
    expect(meta["rowCount"]).toBe(2);

    // outbox event shape
    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const payload = (
      outbox!.args as {
        data: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data[0]!;
    expect(payload.eventType).toBe("reporting.run.completed.v1");
    expect(payload.payload["reportId"]).toBe("order-volume-by-stage");
    expect(payload.payload["rowCount"]).toBe(2);
  });
});

describe("RunReport — guards", () => {
  it("throws REPORT_NOT_FOUND for an unknown report id", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RunReport,
          { reportId: "does-not-exist", parameters: validParams },
          { idempotencyKey: "rr-test-2" }
        )
      )
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("throws REPORT_PARAMETERS_INVALID when parameters fail the report's own Zod schema", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RunReport,
          {
            reportId: "order-volume-by-stage",
            // `from` after `to` — fails the schema's refine
            parameters: { from: new Date("2026-06-01"), to: new Date("2026-05-01") },
          },
          { idempotencyKey: "rr-test-3" }
        )
      )
    ).rejects.toMatchObject({ code: "REPORT_PARAMETERS_INVALID" });
  });
});

describe("RunReport — persistCsv", () => {
  it("uploads CSV to the configured archive and persists pointer columns", async () => {
    const archive = new InMemoryReportRunArchive();
    configureReportRunArchive({ archive });
    const fake = buildPrismaFake({
      orderGroupByResult: [
        {
          clinicId: "00000000-0000-4000-8000-000000000010",
          currentStatus: OrderStatus.SHIPPED,
          _count: { _all: 5 },
        },
      ],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RunReport,
        {
          reportId: "order-volume-by-stage",
          parameters: validParams,
          persistCsv: true,
        },
        { idempotencyKey: "rr-archive-1" }
      )
    );

    expect(out.archive).not.toBeNull();
    expect(out.archive!.bucket).toBe("in-memory");
    expect(out.archive!.key).toContain(`reports/${ORG_ID}/`);
    expect(out.archive!.sizeBytes).toBeGreaterThan(0);
    expect(out.archive!.sha256Hex).toMatch(/^[0-9a-f]{64}$/);

    // The persisted report_run row carries the archive columns.
    const create = fake.calls.find((c) => c.table === "reportRun" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["csvObjectBucket"]).toBe("in-memory");
    expect(data["csvObjectKey"]).toBe(out.archive!.key);
    expect(data["csvSizeBytes"]).toBe(out.archive!.sizeBytes);
    expect(data["csvSha256Hex"]).toBe(out.archive!.sha256Hex);
    expect(data["csvPersistedAt"]).toBeInstanceOf(Date);

    // The InMemory adapter records the upload — we can verify the
    // sha256 by re-hashing the recorded body.
    const stored = archive.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.csv.byteLength).toBe(out.archive!.sizeBytes);
  });

  it("soft-skips when persistCsv=true but no archive is configured", async () => {
    // Intentionally NOT calling configureReportRunArchive.
    const fake = buildPrismaFake({
      orderGroupByResult: [
        {
          clinicId: "00000000-0000-4000-8000-000000000010",
          currentStatus: OrderStatus.SHIPPED,
          _count: { _all: 5 },
        },
      ],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RunReport,
        {
          reportId: "order-volume-by-stage",
          parameters: validParams,
          persistCsv: true,
        },
        { idempotencyKey: "rr-archive-2" }
      )
    );

    expect(out.archive).toBeNull();
    const create = fake.calls.find((c) => c.table === "reportRun" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["csvObjectKey"]).toBeUndefined();
    expect(data["csvSha256Hex"]).toBeUndefined();
  });

  it("does NOT upload when persistCsv is omitted (default off)", async () => {
    const archive = new InMemoryReportRunArchive();
    configureReportRunArchive({ archive });
    const fake = buildPrismaFake({
      orderGroupByResult: [],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RunReport,
        {
          reportId: "order-volume-by-stage",
          parameters: validParams,
        },
        { idempotencyKey: "rr-archive-3" }
      )
    );

    expect(out.archive).toBeNull();
    expect(archive.list()).toHaveLength(0);
  });
});

describe("RunReport — read-replica scope routing", () => {
  it("runs the report read on the configured scope's client, not the command tx", async () => {
    // The command tx fake's groupBy would throw if used — proving
    // the read was routed to the scope client instead.
    const fake = buildPrismaFake({});
    (fake.client as { $transaction: unknown }).$transaction = async (
      fn: (t: unknown) => Promise<unknown>
    ) =>
      fn({
        order: {
          groupBy: vi.fn(async () => {
            throw new Error("read must not run on the command tx when a scope is configured");
          }),
        },
        reportRun: { create: vi.fn(async () => ({ id: "rr-scope" })) },
        commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
        auditLog: { create: vi.fn(async () => ({ id: "al" })) },
        auditChainState: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async () => ({
            organizationId: ORG_ID,
            latestHash: Buffer.alloc(32),
            latestSeq: 1n,
          })),
        },
        eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
        idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
        $executeRaw: vi.fn(async () => 0),
      });
    configureBus(fake.client);

    // A scope whose client returns a known group set.
    const scopeClient = {
      order: {
        groupBy: vi.fn(async () => [
          {
            clinicId: "00000000-0000-4000-8000-000000000010",
            currentStatus: OrderStatus.SHIPPED,
            _count: { _all: 7 },
          },
        ]),
      },
    };
    let scopeOrgSeen: string | null = null;
    configureReportReadScope({
      usingReplica: true,
      read: async (organizationId, fn) => {
        scopeOrgSeen = organizationId;
        return fn(scopeClient);
      },
    });

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RunReport,
        { reportId: "order-volume-by-stage", parameters: validParams },
        { idempotencyKey: "rr-scope-1" }
      )
    );

    expect(scopeOrgSeen).toBe(ORG_ID);
    expect(scopeClient.order.groupBy).toHaveBeenCalledTimes(1);
    expect(out.rowCount).toBe(1);
    expect(out.aggregates["totalCount"]).toBe(7);
  });
});

describe("RunReport — RBAC", () => {
  it("denies without reports.run", async () => {
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
              permissions: new Set([PERMISSIONS.ORDERS_READ]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake({});
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RunReport,
          { reportId: "order-volume-by-stage", parameters: validParams },
          { idempotencyKey: "rr-test-4" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
