// ReprintVialLabel contract tests — reprint reason + new print job.

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

import { ReprintVialLabel, VIAL_LABEL_NOT_FOUND } from "./reprint-vial-label.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const LOT_ID = "00000000-0000-4000-8000-0000000000cc";
const PRINTER_ID = "00000000-0000-4000-8000-0000000000dd";
const VIAL_LABEL_ID = "00000000-0000-4000-8000-0000000000ee";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000ff";
const PRESCRIPTION_ID = "00000000-0000-4000-8000-000000000100";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const WORKSTATION_ID = "00000000-0000-4000-8000-0000000000ws";
const NDC = "12345678901";

const fillGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FILL_REPRINT_VIAL_LABEL]),
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
  reprintReasonCode: "LABEL_DAMAGED" as const,
  templateCode: DEFAULT_VIAL_TEMPLATE_CODE,
});

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  vialLabel?: Record<string, unknown> | null;
  orderLineForRender?: Record<string, unknown> | null;
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
  const vialLabel = overrides.vialLabel === undefined ? { id: VIAL_LABEL_ID } : overrides.vialLabel;
  const orderLineForRender =
    overrides.orderLineForRender === undefined
      ? buildOrderLineForRender()
      : overrides.orderLineForRender;

  const tx = {
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: USER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: 1 };
      }),
    },
    vialLabel: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "vialLabel", op: "findFirst", args });
        return vialLabel;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "vialLabel", op: "update", args });
        return { id: VIAL_LABEL_ID };
      }),
    },
    labelPrinter: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "labelPrinter", op: "findFirst", args });
        return {
          id: PRINTER_ID,
          siteId: SITE_ID,
          labelStock: LabelStockKind.VIAL,
          status: LabelPrinterStatus.ACTIVE,
          vendor: LabelPrinterVendor.ZEBRA,
          protocol: LabelPrinterProtocol.ZPL,
        };
      }),
    },
    printTemplate: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "printTemplate", op: "findFirst", args });
        return { id: "tpl-1", version: 1, zplBody: DEFAULT_VIAL_ZPL_TEMPLATE };
      }),
    },
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return orderLineForRender;
      }),
    },
    printJob: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "create", args });
        return { id: "pj-reprint-1" };
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
    $queryRaw: vi.fn(async (_template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      calls.push({ table: "$queryRaw", op: "select_for_update_order", args: values });
      return [
        {
          id: ORDER_ID,
          organizationId: ORG_ID,
          siteId: SITE_ID,
          currentStatus: "FILL_IN_PROGRESS",
          version: 5,
        },
      ];
    }),
    $executeRaw: vi.fn(async () => 0),
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
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "reprint-vial-label-test" }) });
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

describe("ReprintVialLabel — happy path", () => {
  it("creates isReprint print job and updates activePrintJobId", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ReprintVialLabel, validInput(), { idempotencyKey: "reprint-1" })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      orderLineId: ORDER_LINE_ID,
      printJobId: "pj-reprint-1",
      vialLabelId: VIAL_LABEL_ID,
      reprintReasonCode: "LABEL_DAMAGED",
      version: 6,
    });

    const printJobData = (
      callsOf(fake.calls, "printJob", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(printJobData).toMatchObject({
      isReprint: true,
      reprintReasonCode: "LABEL_DAMAGED",
      status: "PENDING",
    });

    const vialUpdate = (
      callsOf(fake.calls, "vialLabel", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(vialUpdate).toMatchObject({ activePrintJobId: "pj-reprint-1" });

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({
      eventType: "labels.vial_print.reprint_requested.v1",
    });
  });
});

describe("ReprintVialLabel — guards", () => {
  it("no vial label → VIAL_LABEL_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ vialLabel: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReprintVialLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: VIAL_LABEL_NOT_FOUND });
    });
  });

  it("invalid reprint reason → COMMAND_INPUT_INVALID", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ReprintVialLabel,
          { ...validInput(), reprintReasonCode: "NOT_A_REASON" as "LABEL_DAMAGED" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});
