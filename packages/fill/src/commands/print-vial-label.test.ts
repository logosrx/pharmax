// PrintVialLabel contract tests — thermal ZPL render + print job creation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  encryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
  type CiphertextEnvelope,
} from "@pharmax/crypto";
import {
  LabelPrinterProtocol,
  LabelPrinterStatus,
  LabelPrinterVendor,
  LabelStockKind,
  Prisma,
  RoleScope,
} from "@pharmax/database";
import { DEFAULT_VIAL_TEMPLATE_CODE, DEFAULT_VIAL_ZPL_TEMPLATE } from "@pharmax/labels";
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
  PrintVialLabel,
  PRINTER_INACTIVE,
  PRINTER_NOT_FOUND,
  PRINTER_NOT_THERMAL,
  PRINT_TEMPLATE_NOT_FOUND,
  VIAL_LABEL_ALREADY_EXISTS,
} from "./print-vial-label.js";
import { VIAL_LABEL_LOT_NOT_ASSIGNED } from "../load-vial-label-context.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const LOT_ID = "00000000-0000-4000-8000-0000000000cc";
const PRINTER_ID = "00000000-0000-4000-8000-0000000000dd";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000ee";
const PRESCRIPTION_ID = "00000000-0000-4000-8000-0000000000ff";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const WORKSTATION_ID = "00000000-0000-4000-8000-0000000000ws";
const NDC = "12345678901";

const fillGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FILL_PRINT_VIAL_LABEL]),
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

const validInput = () => ({
  orderId: ORDER_ID,
  orderLineId: ORDER_LINE_ID,
  printerId: PRINTER_ID,
  templateCode: DEFAULT_VIAL_TEMPLATE_CODE,
});

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  assigneeUserId?: string | null;
  existingVialLabel?: { id: string } | null;
  printer?: Record<string, unknown> | null;
  template?: Record<string, unknown> | null;
  orderLineForRender?: Record<string, unknown> | null;
  orderUpdateManyCount?: number;
}

let firstNameEnc: CiphertextEnvelope;
let lastNameEnc: CiphertextEnvelope;
let sigEnc: CiphertextEnvelope;

function buildOrderLineForRender(): Record<string, unknown> {
  return {
    id: ORDER_LINE_ID,
    quantityToFill: new Prisma.Decimal(10),
    daysSupplyToFill: 30,
    lotId: LOT_ID,
    prescription: {
      id: PRESCRIPTION_ID,
      rxNumber: "RX-1001",
      drugNdc: NDC,
      drugName: "Testosterone Cypionate",
      drugStrength: "200mg/mL",
      sigEnc,
    },
    order: {
      patientId: PATIENT_ID,
      patient: {
        id: PATIENT_ID,
        firstNameEnc,
        lastNameEnc,
      },
    },
    lot: {
      lotNumber: "LOT-A1",
      expirationDate: new Date("2027-12-31T00:00:00.000Z"),
    },
  };
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "FILL_IN_PROGRESS", version: 5 }
      : overrides.lockedRow;
  const assigneeUserId =
    overrides.assigneeUserId === undefined ? USER_ID : overrides.assigneeUserId;
  const existingVialLabel = overrides.existingVialLabel ?? null;
  const printer =
    overrides.printer === undefined
      ? {
          id: PRINTER_ID,
          siteId: SITE_ID,
          labelStock: LabelStockKind.VIAL,
          status: LabelPrinterStatus.ACTIVE,
          vendor: LabelPrinterVendor.ZEBRA,
          protocol: LabelPrinterProtocol.ZPL,
        }
      : overrides.printer;
  const template =
    overrides.template === undefined
      ? {
          id: "tpl-1",
          version: 1,
          zplBody: DEFAULT_VIAL_ZPL_TEMPLATE,
        }
      : overrides.template;
  const orderLineForRender =
    overrides.orderLineForRender === undefined
      ? buildOrderLineForRender()
      : overrides.orderLineForRender;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;

  const tx = {
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: assigneeUserId };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    vialLabel: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "vialLabel", op: "findFirst", args });
        return existingVialLabel;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "vialLabel", op: "create", args });
        return { id: "vl-1" };
      }),
    },
    labelPrinter: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "labelPrinter", op: "findFirst", args });
        return printer;
      }),
    },
    printTemplate: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "printTemplate", op: "findFirst", args });
        return template;
      }),
    },
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return orderLineForRender;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "update", args });
        return { id: ORDER_LINE_ID };
      }),
    },
    printJob: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "create", args });
        return { id: "pj-1" };
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
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      const op =
        /\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)
          ? "select_for_update_order"
          : "raw";
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
      if (op === "select_for_update_order") {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                siteId: SITE_ID,
                currentStatus: lockedRow.currentStatus,
                version: lockedRow.version,
              },
            ];
      }
      return [];
    }),
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

beforeEach(async () => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "print-vial-label-test" }) });
  firstNameEnc = await encryptField({
    plaintext: "Alex",
    binding: { tenantId: ORG_ID, table: "patient", column: "firstName", recordId: PATIENT_ID },
  });
  lastNameEnc = await encryptField({
    plaintext: "Sample",
    binding: { tenantId: ORG_ID, table: "patient", column: "lastName", recordId: PATIENT_ID },
  });
  sigEnc = await encryptField({
    plaintext: "Inject weekly",
    binding: {
      tenantId: ORG_ID,
      table: "prescription",
      column: "sig",
      recordId: PRESCRIPTION_ID,
    },
  });

  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: fillGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("PrintVialLabel — happy path", () => {
  it("creates PENDING print job + vial label with rendered ZPL", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "print-1" })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      orderLineId: ORDER_LINE_ID,
      printJobId: "pj-1",
      vialLabelId: "vl-1",
      version: 6,
    });
    expect(out.contentHashHex).toMatch(/^[0-9a-f]{64}$/);

    const printJobData = (
      callsOf(fake.calls, "printJob", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(printJobData).toMatchObject({
      status: "PENDING",
      isReprint: false,
      workstationId: WORKSTATION_ID,
    });
    expect(String(printJobData["renderedZpl"])).toContain("Alex Sample");
    expect(String(printJobData["renderedZpl"])).toContain("^XA");

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({
      eventType: "labels.vial_print.requested.v1",
      aggregateId: "pj-1",
    });

    const auditJson = JSON.stringify(
      (callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: unknown }).data,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    );
    expect(auditJson).not.toMatch(/Alex|Sample|Inject weekly/i);
  });
});

describe("PrintVialLabel — guards", () => {
  it("existing vial label → VIAL_LABEL_ALREADY_EXISTS", async () => {
    const fake = buildPrismaFake({ existingVialLabel: { id: "vl-existing" } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: VIAL_LABEL_ALREADY_EXISTS });
    });
  });

  it("lot not assigned on line → VIAL_LABEL_LOT_NOT_ASSIGNED", async () => {
    const fake = buildPrismaFake({
      orderLineForRender: {
        ...buildOrderLineForRender(),
        lotId: null,
        lot: null,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: VIAL_LABEL_LOT_NOT_ASSIGNED });
    });
  });

  it("printer missing → PRINTER_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ printer: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: PRINTER_NOT_FOUND });
    });
  });

  it("inactive printer → PRINTER_INACTIVE", async () => {
    const fake = buildPrismaFake({
      printer: {
        id: PRINTER_ID,
        siteId: SITE_ID,
        labelStock: LabelStockKind.VIAL,
        status: LabelPrinterStatus.INACTIVE,
        vendor: LabelPrinterVendor.ZEBRA,
        protocol: LabelPrinterProtocol.ZPL,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: PRINTER_INACTIVE });
    });
  });

  it("non-vial printer → PRINTER_NOT_THERMAL", async () => {
    const fake = buildPrismaFake({
      printer: {
        id: PRINTER_ID,
        siteId: SITE_ID,
        labelStock: LabelStockKind.SHIP_4X6,
        status: LabelPrinterStatus.ACTIVE,
        vendor: LabelPrinterVendor.ZEBRA,
        protocol: LabelPrinterProtocol.ZPL,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: PRINTER_NOT_THERMAL });
    });
  });

  it("template missing → PRINT_TEMPLATE_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ template: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: PRINT_TEMPLATE_NOT_FOUND });
    });
  });

  it("workstation required → COMMAND_WORKSTATION_REQUIRED", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(
      buildTenancyContext({
        organizationId: ORG_ID,
        actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
      }),
      async () => {
        await expect(
          executeCommand(PrintVialLabel, validInput(), { idempotencyKey: "k" })
        ).rejects.toMatchObject({ code: "COMMAND_WORKSTATION_REQUIRED" });
      }
    );
  });
});
