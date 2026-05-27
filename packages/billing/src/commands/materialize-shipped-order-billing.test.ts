// MaterializeShippedOrderBilling contract tests.
//
// Surface:
//   - Happy path (fresh org / fresh period): invoice + invoice line
//     created, totals incremented, outbox event emitted.
//   - Existing invoice for the same period: re-uses the invoice,
//     appends a line, increments totals.
//   - Idempotent replay: re-running with the same orderId is a no-op
//     (returns alreadyMaterialized=true, no second line, no outbox).
//   - P2002 race on the unique billingEventKey: handler reads the
//     winner row and reports as already-materialized.
//   - Cross-org clinic → MATERIALIZE_BILLING_CLINIC_NOT_FOUND.
//   - Audit + outbox shape carries the (orgId, clinicId, invoiceId,
//     invoiceLineId, billingEventKey, pricingScheme) snapshot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import {
  FLAT_DISPENSE_FEE_CENTS,
  MATERIALIZE_BILLING_CLINIC_NOT_FOUND,
  MaterializeShippedOrderBilling,
} from "./materialize-shipped-order-billing.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SHIPMENT_ID = "00000000-0000-4000-8000-000000000ee0";
const OCCURRED_AT = "2026-05-25T17:00:00.000Z";
const EXPECTED_INVOICE_NUMBER = "INV-2026-05-0c0c0c0c";

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  /** Pre-existing invoice line (drives the idempotent short-circuit). */
  existingLine?: { id: string; invoiceId: string; amountCents: number } | null;
  /** Pre-existing invoice for the period (drives the "append to existing" branch). */
  existingInvoice?: { id: string } | null;
  /** Clinic resolution: "ok" (same org), "missing", "other-org". */
  clinicResolution?: "ok" | "missing" | "other-org";
  /**
   * If set, `invoiceLine.create` throws this error. Used to drive the
   * P2002 race-resolution branch.
   */
  invoiceLineCreateError?: Error;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  let invoiceCounter = 0;
  const newInvoiceId = (): string =>
    `1111aaaa-1111-4111-8111-${String(++invoiceCounter).padStart(12, "0")}`;
  let lineCounter = 0;
  const newLineId = (): string =>
    `2222bbbb-2222-4222-8222-${String(++lineCounter).padStart(12, "0")}`;

  const invoiceLineCreateError = overrides.invoiceLineCreateError;

  const tx = {
    invoiceLine: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "findUnique", args });
        return overrides.existingLine ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "create", args });
        if (invoiceLineCreateError !== undefined) {
          throw invoiceLineCreateError;
        }
        return { id: newLineId() };
      }),
    },
    invoice: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findUnique", args });
        const where = (args as { where: { id?: string } }).where;
        if (typeof where.id === "string") {
          return { invoiceNumber: EXPECTED_INVOICE_NUMBER };
        }
        return overrides.existingInvoice ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "create", args });
        return { id: newInvoiceId() };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "update", args });
        return {};
      }),
    },
    clinic: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findUnique", args });
        const resolution = overrides.clinicResolution ?? "ok";
        if (resolution === "missing") return null;
        if (resolution === "other-org") {
          return { id: CLINIC_ID, organizationId: OTHER_ORG_ID };
        }
        return { id: CLINIC_ID, organizationId: ORG_ID };
      }),
    },
    pricingRule: {
      // No rules configured → resolver returns null → handler
      // falls back to FLAT_V1. Tests that exercise rule-driven
      // pricing override this in their own fake.
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "pricingRule", op: "findMany", args });
        return [];
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
        return { count: 1 };
      }),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T17:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  const fake = buildPrismaFake({});
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

const validInput = {
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
  siteId: SITE_ID,
  orderId: ORDER_ID,
  shipmentId: SHIPMENT_ID,
  occurredAt: OCCURRED_AT,
};

describe("MaterializeShippedOrderBilling — happy path (no invoice yet)", () => {
  it("creates the invoice, appends a line, increments totals, emits the v1 event", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MaterializeShippedOrderBilling, validInput)
    );

    expect(out.alreadyMaterialized).toBe(false);
    expect(out.invoiceCreated).toBe(true);
    expect(out.invoiceNumber).toBe(EXPECTED_INVOICE_NUMBER);
    expect(out.amountCents).toBe(FLAT_DISPENSE_FEE_CENTS);

    // Invoice created with the expected derived number + period.
    const invoiceCreate = fake.calls.find((c) => c.table === "invoice" && c.op === "create");
    expect(invoiceCreate).toBeDefined();
    const invoiceData = (invoiceCreate!.args as { data: Record<string, unknown> }).data;
    expect(invoiceData["invoiceNumber"]).toBe(EXPECTED_INVOICE_NUMBER);
    expect(invoiceData["status"]).toBe("DRAFT");
    expect(invoiceData["currency"]).toBe("usd");

    // Line created with billingEventKey + flat dispense fee.
    const lineCreate = fake.calls.find((c) => c.table === "invoiceLine" && c.op === "create");
    const lineData = (lineCreate!.args as { data: Record<string, unknown> }).data;
    expect(lineData["billingEventKey"]).toBe(`ord-shipped:${ORDER_ID}`);
    expect(lineData["kind"]).toBe("DISPENSE_FEE");
    expect(lineData["amountCents"]).toBe(FLAT_DISPENSE_FEE_CENTS);
    expect(lineData["orderId"]).toBe(ORDER_ID);

    // Invoice totals atomically incremented.
    const invoiceUpdate = fake.calls.find((c) => c.table === "invoice" && c.op === "update");
    const updateData = (invoiceUpdate!.args as { data: Record<string, unknown> }).data;
    expect(updateData["subtotalCents"]).toEqual({ increment: FLAT_DISPENSE_FEE_CENTS });
    expect(updateData["totalCents"]).toEqual({ increment: FLAT_DISPENSE_FEE_CENTS });
    expect(updateData["amountDueCents"]).toEqual({ increment: FLAT_DISPENSE_FEE_CENTS });
    expect(updateData["version"]).toEqual({ increment: 1 });

    // Outbox v1 event with the full snapshot.
    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice_line.created.v1");
    expect(outboxData[0]?.payload["invoiceId"]).toBe(out.invoiceId);
    expect(outboxData[0]?.payload["amountCents"]).toBe(FLAT_DISPENSE_FEE_CENTS);
    expect(outboxData[0]?.payload["pricingScheme"]).toBe("FLAT_V1");
    expect(outboxData[0]?.payload["billingPeriodKey"]).toBe("2026-05");
  });
});

describe("MaterializeShippedOrderBilling — pricing-rule resolution", () => {
  it("uses a matching CLINIC-scoped pricing rule and stamps RULE_V2", async () => {
    const fake = buildPrismaFake({});
    // Override the pricingRule.findMany on the existing fake's tx
    // so the resolver picks the clinic rule.
    const tx = (fake.client as { $transaction: ReturnType<typeof vi.fn> }).$transaction;
    tx.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      const ruleRow = {
        id: "rule-clinic-1",
        clinicId: CLINIC_ID,
        productId: null,
        kind: "DISPENSE_FEE",
        unitAmountCents: 7500,
        currency: "usd",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        status: "ACTIVE",
      };
      const subTx = {
        invoiceLine: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: "line-rule-1" })),
        },
        invoice: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: "invoice-rule-1" })),
          update: vi.fn(async () => ({})),
        },
        clinic: {
          findUnique: vi.fn(async () => ({ id: CLINIC_ID, organizationId: ORG_ID })),
        },
        pricingRule: {
          findMany: vi.fn(async () => [ruleRow]),
        },
        commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
        auditLog: { create: vi.fn(async () => ({ id: "al" })) },
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
        eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
        $executeRaw: vi.fn(async () => 0),
      };
      return fn(subTx);
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MaterializeShippedOrderBilling, validInput)
    );

    expect(out.pricingScheme).toBe("RULE_V2");
    expect(out.pricingRuleId).toBe("rule-clinic-1");
    expect(out.amountCents).toBe(7500);
  });
});

describe("MaterializeShippedOrderBilling — existing invoice for the period", () => {
  it("re-uses the open invoice and appends a new line", async () => {
    const fake = buildPrismaFake({
      existingInvoice: { id: "1111aaaa-1111-4111-8111-existing0001" },
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MaterializeShippedOrderBilling, validInput)
    );

    expect(out.invoiceCreated).toBe(false);
    expect(out.alreadyMaterialized).toBe(false);
    expect(out.invoiceId).toBe("1111aaaa-1111-4111-8111-existing0001");

    // No invoice.create — the existing one was returned.
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "create")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.table === "invoiceLine" && c.op === "create")).toHaveLength(
      1
    );
  });
});

describe("MaterializeShippedOrderBilling — idempotency", () => {
  it("short-circuits when an invoice line already exists for the orderId", async () => {
    const fake = buildPrismaFake({
      existingLine: {
        id: "2222bbbb-2222-4222-8222-existing0001",
        invoiceId: "1111aaaa-1111-4111-8111-existing0001",
        amountCents: FLAT_DISPENSE_FEE_CENTS,
      },
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MaterializeShippedOrderBilling, validInput)
    );

    expect(out.alreadyMaterialized).toBe(true);
    expect(out.invoiceLineId).toBe("2222bbbb-2222-4222-8222-existing0001");
    expect(out.invoiceId).toBe("1111aaaa-1111-4111-8111-existing0001");

    // No mutations — short-circuit before any writes.
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "create")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.table === "invoiceLine" && c.op === "create")).toHaveLength(
      0
    );
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "update")).toHaveLength(0);

    // No outbox event — replay is silent so downstream Stripe push
    // doesn't redo the invoice push under retry storms.
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });

  it("treats a P2002 race on billingEventKey as already-materialized", async () => {
    const fake = buildPrismaFake({
      invoiceLineCreateError: new Prisma.PrismaClientKnownRequestError("unique violation", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    });
    configureBus(fake.client);

    // The first findUnique returns null (no line yet), but after
    // create throws P2002, the handler re-reads — re-configure the
    // fake so the second findUnique returns the "winner" row.
    const tx = (
      fake.client as {
        $transaction: ReturnType<typeof vi.fn>;
      }
    ).$transaction;
    // Re-wrap: on second invoiceLine.findUnique call, return the winner.
    let findUniqueCallCount = 0;
    tx.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      const subTx = {
        invoiceLine: {
          findUnique: vi.fn(async () => {
            findUniqueCallCount += 1;
            if (findUniqueCallCount === 1) return null;
            return {
              id: "2222bbbb-race-resolved",
              invoiceId: "1111aaaa-race-resolved",
              amountCents: FLAT_DISPENSE_FEE_CENTS,
            };
          }),
          create: vi.fn(async () => {
            throw new Prisma.PrismaClientKnownRequestError("unique violation", {
              code: "P2002",
              clientVersion: "5.22.0",
            });
          }),
        },
        invoice: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: "1111aaaa-race-resolved" })),
          update: vi.fn(async () => ({})),
        },
        clinic: {
          findUnique: vi.fn(async () => ({ id: CLINIC_ID, organizationId: ORG_ID })),
        },
        pricingRule: {
          findMany: vi.fn(async () => []),
        },
        commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
        auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
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
        eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
        $executeRaw: vi.fn(async () => 0),
      };
      return fn(subTx);
    });

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MaterializeShippedOrderBilling, validInput)
    );

    expect(out.alreadyMaterialized).toBe(true);
    expect(out.invoiceLineId).toBe("2222bbbb-race-resolved");
  });
});

describe("MaterializeShippedOrderBilling — guards", () => {
  it("rejects when the clinic does not belong to the organization", async () => {
    const fake = buildPrismaFake({ clinicResolution: "other-org" });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () =>
        executeSystemCommand(MaterializeShippedOrderBilling, validInput)
      )
    ).rejects.toMatchObject({ code: MATERIALIZE_BILLING_CLINIC_NOT_FOUND });
  });

  it("rejects when the clinic is missing", async () => {
    const fake = buildPrismaFake({ clinicResolution: "missing" });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () =>
        executeSystemCommand(MaterializeShippedOrderBilling, validInput)
      )
    ).rejects.toMatchObject({ code: MATERIALIZE_BILLING_CLINIC_NOT_FOUND });
  });
});
