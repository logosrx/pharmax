// Unit tests for the order-shipped → billing-materialization outbox
// handler. Drives the real handler against an in-process command
// bus + system tenancy; stubs only the Prisma surface the
// SystemCommand touches.

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { clock, logger as loggerNs } from "@pharmax/platform-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMaterializeBillingOnOrderShippedHandler } from "./materialize-billing-on-order-shipped.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SHIPMENT_ID = "00000000-0000-4000-8000-000000000ee0";

function buildPrismaFake() {
  const invoiceCreate = vi.fn(async () => ({ id: "1111aaaa-1111-4111-8111-000000000001" }));
  const invoiceLineCreate = vi.fn(async () => ({ id: "2222bbbb-2222-4222-8222-000000000001" }));

  const tx = {
    invoiceLine: {
      findUnique: vi.fn(async () => null),
      create: invoiceLineCreate,
    },
    invoice: {
      findUnique: vi.fn(async (args: unknown) => {
        const where = (args as { where: { id?: string } }).where;
        if (typeof where.id === "string") {
          return { invoiceNumber: "INV-2026-05-0c0c0c0c" };
        }
        return null;
      }),
      create: invoiceCreate,
      update: vi.fn(async () => ({})),
    },
    clinic: {
      findUnique: vi.fn(async () => ({ id: CLINIC_ID, organizationId: ORG_ID })),
    },
    pricingRule: {
      // Resolver finds no rule → handler falls back to FLAT_V1.
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

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, invoiceCreate, invoiceLineCreate };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T17:00:00.000Z")),
    logger: loggerNs.noopLogger,
  });
}

function buildRow(payload: Record<string, unknown>): ClaimedOutboxEventRow {
  return {
    id: "outbox-shipped-1",
    organizationId: ORG_ID,
    eventType: "order.shipped.v1",
    aggregateType: "Order",
    aggregateId: ORDER_ID,
    payload,
    attempts: 1,
    occurredAt: new Date("2026-05-25T17:00:00.000Z"),
  } as unknown as ClaimedOutboxEventRow;
}

const HANDLER_CTX = { logger: loggerNs.noopLogger, receivedAt: new Date() };

beforeEach(() => {
  const fake = buildPrismaFake();
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("createMaterializeBillingOnOrderShippedHandler — happy path", () => {
  it("dispatches MaterializeShippedOrderBilling with the payload fields", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const handler = createMaterializeBillingOnOrderShippedHandler();
    const row = buildRow({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      orderId: ORDER_ID,
      shipmentId: SHIPMENT_ID,
      trackingNumber: "1Z999AA10123456784",
      occurredAt: "2026-05-25T17:00:00.000Z",
    });

    await handler(row, HANDLER_CTX);

    // Invoice + line both materialized end-to-end.
    expect(fake.invoiceCreate).toHaveBeenCalledTimes(1);
    expect(fake.invoiceLineCreate).toHaveBeenCalledTimes(1);

    // Invoice line points at the source order.
    const lineArgs = fake.invoiceLineCreate.mock.calls[0] as unknown as Array<unknown>;
    const lineData = (lineArgs[0] as { data: Record<string, unknown> }).data;
    expect(lineData["orderId"]).toBe(ORDER_ID);
    expect(lineData["billingEventKey"]).toBe(`ord-shipped:${ORDER_ID}`);
  });
});

describe("createMaterializeBillingOnOrderShippedHandler — payload guards", () => {
  it("throws when clinicId is missing from the payload", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const handler = createMaterializeBillingOnOrderShippedHandler();
    const row = buildRow({
      organizationId: ORG_ID,
      // clinicId intentionally missing
      siteId: SITE_ID,
      orderId: ORDER_ID,
      shipmentId: SHIPMENT_ID,
      occurredAt: "2026-05-25T17:00:00.000Z",
    });

    await expect(handler(row, HANDLER_CTX)).rejects.toMatchObject({
      code: "MATERIALIZE_BILLING_CLINIC_MISSING_FROM_PAYLOAD",
    });
  });

  it("throws when orderId / shipmentId / occurredAt are missing", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const handler = createMaterializeBillingOnOrderShippedHandler();
    const row = buildRow({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      // orderId intentionally missing
      shipmentId: SHIPMENT_ID,
      occurredAt: "2026-05-25T17:00:00.000Z",
    });

    await expect(handler(row, HANDLER_CTX)).rejects.toMatchObject({
      code: "MATERIALIZE_BILLING_PAYLOAD_INCOMPLETE",
    });
  });
});
