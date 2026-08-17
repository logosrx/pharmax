// Contract tests for compound stock label printing.
//
// Invariants under test:
//   1. A first batch-label print creates a PENDING job with rendered
//      ZPL, its content hash, and the batch's barcode payload.
//   2. A second print of the same target REQUIRES a reason code — the
//      command derives "this is a reprint" from print-job history, so
//      there is no endpoint that produces a silent duplicate label.
//   3. A lab-REJECTED batch cannot be labelled at all. A crisp new
//      label is how rejected product gets mistaken for released
//      product on a shelf.
//   4. Printer guards: wrong site, inactive, wrong label stock.
//   5. Unit printing emits one job PER UNIT (per-unit attribution) and
//      bounds the run size.
//   6. RBAC denial leaves no command_log footprint.

import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { PrintCompoundBatchLabel, PrintCompoundUnitLabels } from "./print-compound-labels.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const WORKSTATION_ID = "44444444-4444-4444-8444-444444444444";
const BATCH_ID = "55555555-5555-4555-8555-555555555555";
const PRINTER_ID = "66666666-6666-4666-8666-666666666666";
const TEMPLATE_ID = "77777777-7777-4777-8777-777777777777";

const printGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_BATCH_LABEL_PRINT]),
  },
];

const readOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_READ]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    workstationId: WORKSTATION_ID,
  });
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakeOptions {
  batch?: Record<string, unknown> | null;
  printer?: Record<string, unknown> | null;
  template?: Record<string, unknown> | null;
  priorPrintCount?: number;
  units?: Array<{ id: string; unitNumber: number; serialNumber: string }>;
}

function defaultBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    batchNumber: "PHX-T30-1-040327",
    barcodeValue: "PXB:PXP-000042:PHX-T30-1-040327",
    beyondUseDate: new Date("2027-07-02T00:00:00.000Z"),
    compoundedOn: new Date("2027-04-03T00:00:00.000Z"),
    unitCount: 40,
    status: "COMPOUNDED",
    siteId: SITE_ID,
    product: {
      name: "Tirzepatide/Glycine",
      strength: "10mg/20mg/3mL",
      pharmaxProductId: "PXP-000042",
    },
    ...overrides,
  };
}

function buildFakePrisma(opts: FakeOptions = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let createdJobs = 0;

  const tx = {
    compoundBatch: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatch", op: "findFirst", args });
        return opts.batch === undefined ? defaultBatch() : opts.batch;
      }),
    },
    compoundBatchUnit: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatchUnit", op: "findMany", args });
        return (
          opts.units ?? [
            {
              id: "aaaaaaaa-0000-4000-8000-000000000001",
              unitNumber: 1,
              serialNumber: "PHX-T30-1-040327-1",
            },
            {
              id: "aaaaaaaa-0000-4000-8000-000000000002",
              unitNumber: 2,
              serialNumber: "PHX-T30-1-040327-2",
            },
          ]
        );
      }),
    },
    labelPrinter: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "labelPrinter", op: "findFirst", args });
        return opts.printer === undefined
          ? {
              id: PRINTER_ID,
              siteId: SITE_ID,
              labelStock: "BATCH_2X1",
              status: "ACTIVE",
              vendor: "ZEBRA",
              protocol: "ZPL",
            }
          : opts.printer;
      }),
    },
    printTemplate: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "printTemplate", op: "findFirst", args });
        return opts.template === undefined
          ? {
              id: TEMPLATE_ID,
              version: 1,
              zplBody:
                "^XA^FD{{productName}} {{productStrength}} {{compoundedOn}} {{beyondUseDate}} {{unitCount}}^FS^FD{{batchBarcodeValue}}^FS^FD{{pharmaxProductId}}^FS^FD{{batchNumber}}^FS^XZ",
            }
          : opts.template;
      }),
    },
    printJob: {
      count: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "count", args });
        return opts.priorPrintCount ?? 0;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "create", args });
        createdJobs += 1;
        return { id: `bbbbbbbb-0000-4000-8000-00000000000${createdJobs}` };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-1" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "audit-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: unknown) => {
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async () => ({ id: "idem-1" })),
      findUnique: vi.fn(async () => null),
    },
    workstation: {
      findFirst: vi.fn(async () => ({ id: WORKSTATION_ID, siteId: SITE_ID, status: "ACTIVE" })),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cmd-log-pretx" })),
      update: vi.fn(async () => ({ id: "cmd-log-pretx" })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function outboxPayloads(calls: FakeCall[]): Array<Record<string, unknown>> {
  return callsOf(calls, "eventOutbox", "createMany").flatMap(
    (c) => (c.args as { data: Array<Record<string, unknown>> }).data
  );
}

function wire(client: unknown, grants: ReadonlyArray<ResolvedGrant> = printGrants): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2027-04-03T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("PrintCompoundBatchLabel", () => {
  it("queues a PENDING job carrying the batch barcode and the rendered ZPL hash", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        PrintCompoundBatchLabel,
        { batchId: BATCH_ID, printerId: PRINTER_ID },
        { idempotencyKey: "bl-1" }
      )
    );

    expect(out.isReprint).toBe(false);
    expect(out.batchNumber).toBe("PHX-T30-1-040327");
    expect(out.contentHashHex).toMatch(/^[0-9a-f]{64}$/);

    const job = (
      callsOf(fake.calls, "printJob", "create")[0]?.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(job).toMatchObject({
      organizationId: ORG_ID,
      targetKind: "COMPOUND_BATCH",
      compoundBatchId: BATCH_ID,
      status: "PENDING",
      isReprint: false,
      reprintReasonCode: null,
      requestedByUserId: USER_ID,
    });
    // No order columns on a stock label — the DB CHECK requires it.
    expect(job["orderId"]).toBeUndefined();
    expect(job["compoundBatchUnitId"]).toBeUndefined();
    // The barcode payload reaches the printer verbatim.
    expect(String(job["renderedZpl"])).toContain("PXB:PXP-000042:PHX-T30-1-040327");

    const events = outboxPayloads(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "labels.compound_label.requested.v1" });
  });

  it("refuses a second print without a reason code — no silent duplicate labels", async () => {
    const fake = buildFakePrisma({ priorPrintCount: 1 });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundBatchLabel,
          { batchId: BATCH_ID, printerId: PRINTER_ID },
          { idempotencyKey: "bl-dup" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_REPRINT_REASON_REQUIRED" });

    expect(callsOf(fake.calls, "printJob", "create")).toHaveLength(0);
  });

  it("allows a reprint when a reason code is supplied, and records it", async () => {
    const fake = buildFakePrisma({ priorPrintCount: 2 });
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        PrintCompoundBatchLabel,
        { batchId: BATCH_ID, printerId: PRINTER_ID, reprintReasonCode: "BARCODE_UNREADABLE" },
        { idempotencyKey: "bl-reprint" }
      )
    );

    expect(out.isReprint).toBe(true);
    const job = (
      callsOf(fake.calls, "printJob", "create")[0]?.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(job).toMatchObject({ isReprint: true, reprintReasonCode: "BARCODE_UNREADABLE" });

    const audit = (
      callsOf(fake.calls, "auditLog", "create")[0]?.args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.compound_batch_label.reprint_requested");
    expect(audit.metadata).toMatchObject({
      reprintReasonCode: "BARCODE_UNREADABLE",
      priorPrintCount: 2,
    });
  });

  it("refuses to label a lab-rejected batch", async () => {
    const fake = buildFakePrisma({
      batch: defaultBatch({ status: "REJECTED" }),
    });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundBatchLabel,
          { batchId: BATCH_ID, printerId: PRINTER_ID },
          { idempotencyKey: "bl-rejected" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_NOT_LABELABLE" });

    expect(callsOf(fake.calls, "printJob", "create")).toHaveLength(0);
  });

  it("refuses a printer registered at a different site than the batch", async () => {
    const fake = buildFakePrisma({
      printer: {
        id: PRINTER_ID,
        siteId: "99999999-9999-4999-8999-999999999999",
        labelStock: "BATCH_2X1",
        status: "ACTIVE",
        vendor: "ZEBRA",
        protocol: "ZPL",
      },
    });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundBatchLabel,
          { batchId: BATCH_ID, printerId: PRINTER_ID },
          { idempotencyKey: "bl-site" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_PRINTER_NOT_FOUND" });
  });

  it("refuses a printer loaded with the wrong label stock", async () => {
    const fake = buildFakePrisma({
      printer: {
        id: PRINTER_ID,
        siteId: SITE_ID,
        labelStock: "SHIP_4X6",
        status: "ACTIVE",
        vendor: "ZEBRA",
        protocol: "ZPL",
      },
    });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundBatchLabel,
          { batchId: BATCH_ID, printerId: PRINTER_ID },
          { idempotencyKey: "bl-stock" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_PRINTER_WRONG_STOCK" });
  });

  it("refuses an inactive printer", async () => {
    const fake = buildFakePrisma({
      printer: {
        id: PRINTER_ID,
        siteId: SITE_ID,
        labelStock: "BATCH_2X1",
        status: "INACTIVE",
        vendor: "ZEBRA",
        protocol: "ZPL",
      },
    });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundBatchLabel,
          { batchId: BATCH_ID, printerId: PRINTER_ID },
          { idempotencyKey: "bl-inactive" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_PRINTER_INACTIVE" });
  });

  it("denies an actor without the label-print grant", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundBatchLabel,
          { batchId: BATCH_ID, printerId: PRINTER_ID },
          { idempotencyKey: "bl-rbac" }
        )
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
  });
});

describe("PrintCompoundUnitLabels", () => {
  const unitPrinter = {
    id: PRINTER_ID,
    siteId: SITE_ID,
    labelStock: "VIAL",
    status: "ACTIVE",
    vendor: "ZEBRA",
    protocol: "ZPL",
  };
  const unitTemplate = {
    id: TEMPLATE_ID,
    version: 1,
    zplBody:
      "^XA^FD{{productName}} {{productStrength}} {{beyondUseDate}} {{unitNumber}} {{unitCount}}^FS^FD{{serialBarcodeValue}}^FS^FD{{serialNumber}}^FS^XZ",
  };

  it("creates one print job per unit so a failure is attributable to a vial", async () => {
    const fake = buildFakePrisma({ printer: unitPrinter, template: unitTemplate });
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        PrintCompoundUnitLabels,
        { batchId: BATCH_ID, printerId: PRINTER_ID, fromUnitNumber: 1, toUnitNumber: 2 },
        { idempotencyKey: "ul-1" }
      )
    );

    expect(out.printJobIds).toHaveLength(2);
    const jobs = callsOf(fake.calls, "printJob", "create").map(
      (c) => (c.args as { data: Record<string, unknown> }).data
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      targetKind: "COMPOUND_UNIT",
      compoundBatchId: BATCH_ID,
      compoundBatchUnitId: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    // Each unit's own serial reaches its own label.
    expect(String(jobs[0]?.["renderedZpl"])).toContain("PHX-T30-1-040327-1");
    expect(String(jobs[1]?.["renderedZpl"])).toContain("PHX-T30-1-040327-2");

    // One event per unit — this is what makes "prove unit 2 printed" a
    // row lookup rather than an inference about a bulk job.
    expect(outboxPayloads(fake.calls)).toHaveLength(2);
  });

  it("refuses a range that does not fit inside the batch", async () => {
    const fake = buildFakePrisma({ printer: unitPrinter, template: unitTemplate });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundUnitLabels,
          { batchId: BATCH_ID, printerId: PRINTER_ID, fromUnitNumber: 39, toUnitNumber: 41 },
          { idempotencyKey: "ul-range" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_UNIT_RANGE_INVALID" });

    expect(callsOf(fake.calls, "printJob", "create")).toHaveLength(0);
  });

  it("bounds a single run so one command cannot enqueue thousands of jobs", async () => {
    const fake = buildFakePrisma({
      batch: defaultBatch({ unitCount: 5000 }),
      printer: unitPrinter,
      template: unitTemplate,
    });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundUnitLabels,
          { batchId: BATCH_ID, printerId: PRINTER_ID, fromUnitNumber: 1, toUnitNumber: 5000 },
          { idempotencyKey: "ul-huge" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_UNIT_RANGE_TOO_LARGE" });

    expect(callsOf(fake.calls, "printJob", "create")).toHaveLength(0);
  });

  it("requires a reason code when any unit in the range was printed before", async () => {
    const fake = buildFakePrisma({
      printer: unitPrinter,
      template: unitTemplate,
      priorPrintCount: 1,
    });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PrintCompoundUnitLabels,
          { batchId: BATCH_ID, printerId: PRINTER_ID, fromUnitNumber: 1, toUnitNumber: 2 },
          { idempotencyKey: "ul-dup" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_LABEL_REPRINT_REASON_REQUIRED" });
  });
});
