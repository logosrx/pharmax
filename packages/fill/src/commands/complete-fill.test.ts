// CompleteFill contract tests — line prerequisites + workflow transition.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { OrderStageIntervalKind, RoleScope } from "@pharmax/database";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";
import { FINAL_BUCKET_NOT_CONFIGURED } from "@pharmax/verification";

import { buildVialBarcodeValue } from "@pharmax/labels";

import {
  CompleteFill,
  FILL_COMPOUND_BUD_EXPIRED,
  FILL_COMPOUND_QUALITY_FAILED,
  FILL_LABEL_PRINT_NOT_COMPLETE,
  FILL_LOT_NOT_ASSIGNED,
  FILL_SCAN_COMPOUND_LOT_UNEXPECTED,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_LOT_SCAN_REQUIRED,
} from "./complete-fill.js";
import { FILL_WRONG_STATUS } from "../fill-guards.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const LOT_ID = "00000000-0000-4000-8000-0000000000cc";
const VIAL_LABEL_ID = "00000000-0000-4000-8000-0000000000dd";
const PRINT_JOB_ID = "00000000-0000-4000-8000-0000000000ee";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const FINAL_BUCKET_ID = "00000000-0000-4000-8000-0000000000ff";

const fillGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FILL_COMPLETE]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  assigneeUserId?: string | null;
  policy?: { code: string; version: number; status: string } | null;
  lines?: Array<{
    id: string;
    lotId: string | null;
    vialLabelId: string | null;
    lot?: { lotNumber: string; product: { ndc: string } } | null;
    vialLabel?: { activePrintJob: { id: string; status: string } } | null;
    compoundingRecords?: Array<{
      id: string;
      qualityOutcome: string;
      budAt: Date;
      formulaCode: string;
      formulaVersion: number;
    }>;
  }>;
  completedPrintForLine?: boolean;
  finalBucketFound?: boolean;
  orderUpdateManyCount?: number;
  orderEventHead?: { sequenceNumber: number } | null;
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
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const lines =
    overrides.lines === undefined
      ? [
          {
            id: ORDER_LINE_ID,
            lotId: LOT_ID,
            vialLabelId: VIAL_LABEL_ID,
            lot: { lotNumber: "LOT-A1", product: { ndc: "12345678901" } },
          },
        ]
      : overrides.lines;
  const completedPrintForLine = overrides.completedPrintForLine ?? true;
  const finalBucketFound = overrides.finalBucketFound ?? true;
  // The handler reads the label's ACTIVE print job off the line
  // (`vialLabel.activePrintJob`), so derive that relation for
  // fixtures that don't specify it: labelled lines get an active
  // job whose status follows `completedPrintForLine`; label-less
  // lines get null (matches what Prisma returns).
  const linesWithVialLabel = lines.map((line) => ({
    // Real Prisma always returns the selected `compoundingRecords`
    // relation as an array; default to "no records" for fixtures
    // that don't care about the compound path.
    compoundingRecords: [],
    ...line,
    vialLabel:
      line.vialLabel !== undefined
        ? line.vialLabel
        : line.vialLabelId === null
          ? null
          : {
              activePrintJob: {
                id: PRINT_JOB_ID,
                status: completedPrintForLine ? "COMPLETED" : "PENDING",
              },
            },
  }));
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 5 };

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.FILL_ACTIVE
    ),
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policy === null ? null : { id: POLICY_ID, ...policy };
      }),
    },
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: assigneeUserId };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    orderLine: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findMany", args });
        return linesWithVialLabel;
      }),
    },
    printJob: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "printJob", op: "findFirst", args });
        return completedPrintForLine ? { id: PRINT_JOB_ID } : null;
      }),
    },
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return finalBucketFound ? { id: FINAL_BUCKET_ID } : null;
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
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
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
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
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
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
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
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

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: fillGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

function defaultLineScans(): Array<{
  orderLineId: string;
  lotScan: string;
  vialLabelScan: string;
}> {
  return [
    {
      orderLineId: ORDER_LINE_ID,
      lotScan: "(10)LOT-A1",
      vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
    },
  ];
}

describe("CompleteFill — happy path", () => {
  it("transitions to FILL_COMPLETED_READY_FOR_FINAL and clears assignee", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CompleteFill,
        { orderId: ORDER_ID, lineScans: defaultLineScans() },
        { idempotencyKey: "complete-fill-1" }
      )
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "FILL_COMPLETED_READY_FOR_FINAL",
      version: 6,
      transitionId: "wf.v1.complete_fill",
    });

    const updateData = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateData).toMatchObject({
      currentStatus: "FILL_COMPLETED_READY_FOR_FINAL",
      currentBucketId: FINAL_BUCKET_ID,
      currentAssigneeUserId: null,
    });

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({
      eventType: "order.fill.completed.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
  });
});

describe("CompleteFill — prerequisites", () => {
  it("missing lot → FILL_LOT_NOT_ASSIGNED", async () => {
    const fake = buildPrismaFake({
      lines: [
        {
          id: ORDER_LINE_ID,
          lotId: null,
          vialLabelId: VIAL_LABEL_ID,
          lot: null,
        },
      ],
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: defaultLineScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_LOT_NOT_ASSIGNED });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("missing vial label → FILL_LABEL_PRINT_NOT_COMPLETE", async () => {
    const fake = buildPrismaFake({
      lines: [
        {
          id: ORDER_LINE_ID,
          lotId: LOT_ID,
          vialLabelId: null,
          lot: { lotNumber: "LOT-A1", product: { ndc: "12345678901" } },
        },
      ],
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: defaultLineScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_LABEL_PRINT_NOT_COMPLETE });
    });
  });

  it("no completed print job → FILL_LABEL_PRINT_NOT_COMPLETE", async () => {
    const fake = buildPrismaFake({ completedPrintForLine: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: defaultLineScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_LABEL_PRINT_NOT_COMPLETE });
    });
  });

  it("lot scan mismatch → FILL_SCAN_LOT_MISMATCH", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          {
            orderId: ORDER_ID,
            lineScans: [
              {
                orderLineId: ORDER_LINE_ID,
                lotScan: "(10)WRONG-LOT",
                vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
              },
            ],
          },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_SCAN_LOT_MISMATCH });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("wrong status → FILL_WRONG_STATUS", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_APPROVED_READY_FOR_FILL", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: defaultLineScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_WRONG_STATUS });
    });
  });

  it("already completed → FILL_WRONG_STATUS", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_COMPLETED_READY_FOR_FINAL", version: 6 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: defaultLineScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_WRONG_STATUS });
    });
  });

  it("FINAL bucket missing → FINAL_BUCKET_NOT_CONFIGURED", async () => {
    const fake = buildPrismaFake({ finalBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: defaultLineScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FINAL_BUCKET_NOT_CONFIGURED });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });
});

// ADR-0035 slice 4: patient-specific compounded preps have no
// finished-goods lot — the latest compounding record for the line is
// the physical-verification anchor.
describe("CompleteFill — compound-prep lines (no finished-goods lot)", () => {
  const CR_ID = "00000000-0000-4000-8000-00000000c001";
  const FUTURE_BUD = new Date("2099-01-01T00:00:00.000Z");
  const PAST_BUD = new Date("2020-01-01T00:00:00.000Z");

  function compoundLine(
    overrides: {
      qualityOutcome?: string;
      budAt?: Date;
      records?: Array<{
        id: string;
        qualityOutcome: string;
        budAt: Date;
        formulaCode: string;
        formulaVersion: number;
      }>;
    } = {}
  ) {
    return {
      id: ORDER_LINE_ID,
      lotId: null,
      vialLabelId: VIAL_LABEL_ID,
      lot: null,
      compoundingRecords: overrides.records ?? [
        {
          id: CR_ID,
          qualityOutcome: overrides.qualityOutcome ?? "PASS",
          budAt: overrides.budAt ?? FUTURE_BUD,
          formulaCode: "MAGIC-MOUTHWASH",
          formulaVersion: 2,
        },
      ],
    };
  }

  function compoundScans(): Array<{ orderLineId: string; vialLabelScan: string }> {
    return [
      {
        orderLineId: ORDER_LINE_ID,
        vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
      },
    ];
  }

  it("completes with a vial-label-only scan when the latest record is PASS", async () => {
    const fake = buildPrismaFake({ lines: [compoundLine()] });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CompleteFill,
        { orderId: ORDER_ID, lineScans: compoundScans() },
        { idempotencyKey: "compound-complete-1" }
      )
    );

    expect(out).toMatchObject({ currentStatus: "FILL_COMPLETED_READY_FOR_FINAL" });

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: { metadata: Record<string, unknown> };
      }
    ).data;
    expect(auditData.metadata).toMatchObject({ compoundLineCount: 1 });
  });

  it("rejects when the latest record is a quality FAIL", async () => {
    const fake = buildPrismaFake({
      lines: [compoundLine({ qualityOutcome: "FAIL" })],
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: compoundScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_COMPOUND_QUALITY_FAILED });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("rejects when the preparation is past its beyond-use date", async () => {
    const fake = buildPrismaFake({ lines: [compoundLine({ budAt: PAST_BUD })] });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: compoundScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_COMPOUND_BUD_EXPIRED });
    });
  });

  it("hard-stops when a lot barcode is scanned for a compound line", async () => {
    const fake = buildPrismaFake({ lines: [compoundLine()] });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          {
            orderId: ORDER_ID,
            lineScans: [
              {
                orderLineId: ORDER_LINE_ID,
                lotScan: "(10)LOT-A1",
                vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
              },
            ],
          },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_SCAN_COMPOUND_LOT_UNEXPECTED });
    });
  });

  it("rejects a stock line whose lot scan is missing", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          {
            orderId: ORDER_ID,
            lineScans: [
              {
                orderLineId: ORDER_LINE_ID,
                vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
              },
            ],
          },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_SCAN_LOT_SCAN_REQUIRED });
    });
  });

  it("a line with neither lot nor record still fails with FILL_LOT_NOT_ASSIGNED", async () => {
    const fake = buildPrismaFake({
      lines: [
        {
          id: ORDER_LINE_ID,
          lotId: null,
          vialLabelId: VIAL_LABEL_ID,
          lot: null,
          compoundingRecords: [],
        },
      ],
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CompleteFill,
          { orderId: ORDER_ID, lineScans: compoundScans() },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: FILL_LOT_NOT_ASSIGNED });
    });
  });

  it("FAIL followed by a re-prep PASS completes (latest record wins)", async () => {
    const fake = buildPrismaFake({
      lines: [
        compoundLine({
          // The handler takes the latest record (query orders by
          // preparedAt desc, take 1) — the fake returns exactly what
          // the query would: the newest row only.
          records: [
            {
              id: CR_ID,
              qualityOutcome: "PASS",
              budAt: FUTURE_BUD,
              formulaCode: "MAGIC-MOUTHWASH",
              formulaVersion: 3,
            },
          ],
        }),
      ],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CompleteFill,
        { orderId: ORDER_ID, lineScans: compoundScans() },
        { idempotencyKey: "compound-reprep-1" }
      )
    );
    expect(out).toMatchObject({ currentStatus: "FILL_COMPLETED_READY_FOR_FINAL" });
  });
});
