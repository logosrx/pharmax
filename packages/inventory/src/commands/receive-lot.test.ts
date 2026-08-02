// Contract tests for ReceiveLot and the lot chain-of-custody read
// (ADR-0035 slice 3).
//
// Invariants under test:
//   1. First receipt creates the lot, credits the ledger with
//      LOT_RECEIVED, and stores a DSCSA row whose NDC comes from OUR
//      catalog product (not from input); the event says lotCreated.
//   2. A second shipment of the same lot reuses the row (no create),
//      still writing a fresh ledger credit + DSCSA row.
//   3. Statutory gates: no receipt without the seller's Transaction
//      Statement; no receipt of already-expired stock. Both refuse
//      BEFORE any write.
//   4. Same lot number + different expiration is a typed conflict,
//      not a merge.
//   5. Site/product must resolve in THIS org — typed NotFound.
//   6. A concurrent first receipt (P2002) is a typed retryable
//      conflict.
//   7. RBAC denial leaves zero command_log footprint.
//   8. getLotChainOfCustody assembles receipts + ledger + dispensing
//      + compounding consumption for one lot, ids only (PHI-safe).

import { afterEach, describe, expect, it, vi } from "vitest";

import { Prisma, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
  type PrismaTxClient,
} from "@pharmax/command-bus";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { ReceiveLot } from "./receive-lot.js";
import { getLotChainOfCustody } from "../queries/lot-chain-of-custody.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";
const LOT_ID = "55555555-5555-4555-8555-555555555555";

const receiverGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_RECEIVE, PERMISSIONS.INVENTORY_READ]),
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
  });
}

function validInput() {
  return {
    siteId: SITE_ID,
    productId: PRODUCT_ID,
    lotNumber: "LOT-2026-0815",
    expirationDate: "2027-06-30",
    quantity: 500,
    dscsa: {
      productName: "Testosterone Cypionate Injection",
      strength: "200 mg/mL",
      dosageForm: "Injectable solution",
      containerSize: "10 mL vial",
      containerCount: 50,
      transactionDate: "2026-07-30",
      shipmentDate: "2026-07-31",
      sellerName: "Synthetic Wholesale Distributors LLC",
      sellerAddress: "100 Fake Distribution Way, Springfield, ZZ 00000",
      buyerName: "Pharmax Test Pharmacy",
      buyerAddress: "200 Fake Pharmacy Blvd, Springfield, ZZ 00000",
      transactionStatementReceived: true,
      sourceDocumentRef: "EPCIS-FAKE-000123",
    },
  };
}

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** Row returned by lot.findFirst. Default: none (first receipt). */
  existingLot?: { id: string; expirationDate: Date } | null;
  /** When false, pharmacySite.findFirst returns null. */
  siteExists?: boolean;
  /** When false, product.findFirst returns null. */
  productExists?: boolean;
  /** When set, lot.create throws this. */
  lotCreateError?: Error;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    pharmacySite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findFirst", args });
        return (opts.siteExists ?? true) ? { id: SITE_ID } : null;
      }),
    },
    product: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findFirst", args });
        return (opts.productExists ?? true) ? { id: PRODUCT_ID, ndc: "00000-0000-01" } : null;
      }),
    },
    lot: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "lot", op: "findFirst", args });
        return opts.existingLot ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "lot", op: "create", args });
        if (opts.lotCreateError !== undefined) throw opts.lotCreateError;
        return (args as { data: { id: string } }).data;
      }),
    },
    inventoryTransaction: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "inventoryTransaction", op: "create", args });
        return { id: "inv-txn-1" };
      }),
    },
    dscsaTransaction: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "dscsaTransaction", op: "create", args });
        return (args as { data: { id: string } }).data;
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
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "audit-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
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
        const data = (args as { data: unknown[] }).data;
        return { count: data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { id: "idem-1" };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        const op = /\bset_config\b/i.test(joined)
          ? "set_config"
          : /\bpg_advisory_xact_lock\b/i.test(joined)
            ? "advisory_lock"
            : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-pretx" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { id: "cmd-log-pretx" };
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

function findOnly(calls: FakeCall[], table: string, op: string): FakeCall {
  const m = callsOf(calls, table, op);
  if (m.length !== 1) {
    throw new Error(`Expected exactly one ${table}.${op}, got ${m.length}`);
  }
  return m[0] as FakeCall;
}

function outboxPayloads(calls: FakeCall[]): Array<Record<string, unknown>> {
  return callsOf(calls, "eventOutbox", "createMany").flatMap(
    (c) => (c.args as { data: Array<Record<string, unknown>> }).data
  );
}

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = receiverGrants
): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-01T12:00:00.000Z")),
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

// ---------------------------------------------------------------------
// ReceiveLot — happy paths
// ---------------------------------------------------------------------

describe("ReceiveLot — first receipt", () => {
  it("creates the lot, credits the ledger, stores the DSCSA record, and emits the event", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-1" })
    );

    expect(out.lotCreated).toBe(true);
    expect(out.lotNumber).toBe("LOT-2026-0815");
    expect(out.quantity).toBe(500);

    const lot = (findOnly(fake.calls, "lot", "create").args as { data: Record<string, unknown> })
      .data;
    expect(lot).toMatchObject({
      id: out.lotId,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      productId: PRODUCT_ID,
      lotNumber: "LOT-2026-0815",
    });
    expect(lot["expirationDate"]).toEqual(new Date("2027-06-30T00:00:00.000Z"));

    const ledger = (
      findOnly(fake.calls, "inventoryTransaction", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(ledger).toMatchObject({
      organizationId: ORG_ID,
      lotId: out.lotId,
      reason: "LOT_RECEIVED",
    });
    expect((ledger["quantityDelta"] as Prisma.Decimal).toString()).toBe("500");

    const dscsa = (
      findOnly(fake.calls, "dscsaTransaction", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(dscsa).toMatchObject({
      id: out.dscsaTransactionId,
      organizationId: ORG_ID,
      lotId: out.lotId,
      productName: "Testosterone Cypionate Injection",
      strength: "200 mg/mL",
      dosageForm: "Injectable solution",
      // NDC comes from OUR catalog, not from input.
      ndc: "00000-0000-01",
      containerSize: "10 mL vial",
      containerCount: 50,
      lotNumber: "LOT-2026-0815",
      sellerName: "Synthetic Wholesale Distributors LLC",
      buyerName: "Pharmax Test Pharmacy",
      transactionStatementReceived: true,
      sourceDocumentRef: "EPCIS-FAKE-000123",
      receivedByUserId: USER_ID,
    });
    expect(dscsa["transactionDate"]).toEqual(new Date("2026-07-30T00:00:00.000Z"));
    expect(dscsa["shipmentDate"]).toEqual(new Date("2026-07-31T00:00:00.000Z"));

    const events = outboxPayloads(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "inventory.lot.received.v1" });
    const payload = events[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      dscsaTransactionId: out.dscsaTransactionId,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      lotId: out.lotId,
      productId: PRODUCT_ID,
      lotNumber: "LOT-2026-0815",
      quantity: 500,
      lotCreated: true,
      receivedByUserId: USER_ID,
    });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.lot.received");
    expect(audit.metadata).toMatchObject({
      lotNumber: "LOT-2026-0815",
      quantity: 500,
      lotCreated: true,
    });
  });

  it("allows receiving stock that expires today (boundary)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const input = { ...validInput(), expirationDate: "2026-08-01" };
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(ReceiveLot, input, { idempotencyKey: "receive-boundary" })
    );
    expect(out.lotCreated).toBe(true);
  });
});

describe("ReceiveLot — subsequent shipment of an existing lot", () => {
  it("reuses the lot row and still writes ledger + DSCSA", async () => {
    const fake = buildFakePrisma({
      existingLot: { id: LOT_ID, expirationDate: new Date("2027-06-30T00:00:00.000Z") },
    });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-2" })
    );

    expect(out.lotId).toBe(LOT_ID);
    expect(out.lotCreated).toBe(false);
    expect(callsOf(fake.calls, "lot", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "dscsaTransaction", "create")).toHaveLength(1);

    const payload = outboxPayloads(fake.calls)[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({ lotId: LOT_ID, lotCreated: false });
  });
});

// ---------------------------------------------------------------------
// ReceiveLot — statutory gates
// ---------------------------------------------------------------------

describe("ReceiveLot — statutory gates", () => {
  it("refuses receipt without the seller's Transaction Statement, before any write", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const input = validInput();
    input.dscsa.transactionStatementReceived = false;

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, input, { idempotencyKey: "receive-no-ts" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_TS_NOT_RECEIVED" });

    expect(callsOf(fake.calls, "lot", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "dscsaTransaction", "create")).toHaveLength(0);
  });

  it("refuses already-expired stock", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    // Frozen clock is 2026-08-01; the day before is expired.
    const input = { ...validInput(), expirationDate: "2026-07-31" };

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, input, { idempotencyKey: "receive-expired" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_LOT_EXPIRED_AT_RECEIPT" });

    expect(callsOf(fake.calls, "lot", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "dscsaTransaction", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// ReceiveLot — conflicts and scoping
// ---------------------------------------------------------------------

describe("ReceiveLot — conflicts and scoping", () => {
  it("rejects the same lot number arriving with a different expiration date", async () => {
    const fake = buildFakePrisma({
      existingLot: { id: LOT_ID, expirationDate: new Date("2027-01-31T00:00:00.000Z") },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-mismatch" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_EXPIRATION_MISMATCH" });

    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(0);
  });

  it("rejects an unknown site with a typed NotFound", async () => {
    const fake = buildFakePrisma({ siteExists: false });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-no-site" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_SITE_NOT_FOUND" });
  });

  it("rejects a product missing from this org's catalog", async () => {
    const fake = buildFakePrisma({ productExists: false });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-no-product" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_PRODUCT_NOT_FOUND" });
  });

  it("translates a concurrent first receipt (P2002) into a typed retryable conflict", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique violation", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildFakePrisma({ lotCreateError: p2002 });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-race" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_RECEIPT_CONFLICT" });

    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "dscsaTransaction", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// ReceiveLot — RBAC
// ---------------------------------------------------------------------

describe("ReceiveLot — RBAC", () => {
  it("denies without inventory.receive and leaves no command_log footprint", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReceiveLot, validInput(), { idempotencyKey: "receive-denied" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "lot", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// getLotChainOfCustody
// ---------------------------------------------------------------------

function buildCustodyFake(opts: { lotExists?: boolean } = {}): PrismaTxClient {
  const lotExists = opts.lotExists ?? true;
  return {
    lot: {
      findFirst: vi.fn(async () =>
        lotExists
          ? {
              id: LOT_ID,
              siteId: SITE_ID,
              productId: PRODUCT_ID,
              lotNumber: "LOT-2026-0815",
              expirationDate: new Date("2027-06-30T00:00:00.000Z"),
              status: "ACTIVE",
            }
          : null
      ),
    },
    dscsaTransaction: {
      findMany: vi.fn(async () => [
        {
          id: "dscsa-1",
          transactionDate: new Date("2026-07-30T00:00:00.000Z"),
          shipmentDate: null,
          sellerName: "Synthetic Wholesale Distributors LLC",
          quantity: new Prisma.Decimal(500),
          containerCount: 50,
          sourceDocumentRef: "EPCIS-FAKE-000123",
          receivedByUserId: USER_ID,
        },
      ]),
    },
    inventoryTransaction: {
      findMany: vi.fn(async () => [
        {
          id: "inv-1",
          quantityDelta: new Prisma.Decimal(500),
          reason: "LOT_RECEIVED",
          orderLineId: null,
          occurredAt: new Date("2026-08-01T12:00:00.000Z"),
        },
        {
          id: "inv-2",
          quantityDelta: new Prisma.Decimal(-30),
          reason: "COMPOUND_CONSUMED",
          orderLineId: "line-1",
          occurredAt: new Date("2026-08-01T13:00:00.000Z"),
        },
      ]),
    },
    lotAssignment: {
      findMany: vi.fn(async () => [
        {
          id: "assign-1",
          orderId: "order-1",
          orderLineId: "line-2",
          assignedByUserId: USER_ID,
          assignedAt: new Date("2026-08-01T14:00:00.000Z"),
        },
      ]),
    },
    compoundingRecordIngredient: {
      findMany: vi.fn(async () => [
        {
          quantity: new Prisma.Decimal(30),
          record: {
            id: "cr-1",
            orderId: "order-1",
            orderLineId: "line-1",
            formulaCode: "MAGIC-MOUTHWASH",
            formulaVersion: 2,
            preparedAt: new Date("2026-08-01T13:00:00.000Z"),
          },
        },
      ]),
    },
  } as unknown as PrismaTxClient;
}

describe("getLotChainOfCustody", () => {
  it("assembles receipts, ledger, dispensing, and compounding consumption for one lot", async () => {
    const custody = await getLotChainOfCustody({
      tx: buildCustodyFake(),
      organizationId: ORG_ID,
      lotId: LOT_ID,
    });

    expect(custody.lot).toEqual({
      id: LOT_ID,
      siteId: SITE_ID,
      productId: PRODUCT_ID,
      lotNumber: "LOT-2026-0815",
      expirationDate: "2027-06-30",
      status: "ACTIVE",
    });
    expect(custody.receipts).toEqual([
      {
        dscsaTransactionId: "dscsa-1",
        transactionDate: "2026-07-30",
        shipmentDate: null,
        sellerName: "Synthetic Wholesale Distributors LLC",
        quantity: "500",
        containerCount: 50,
        sourceDocumentRef: "EPCIS-FAKE-000123",
        receivedByUserId: USER_ID,
      },
    ]);
    expect(custody.ledger).toHaveLength(2);
    expect(custody.ledger[0]).toMatchObject({ reason: "LOT_RECEIVED", quantityDelta: "500" });
    expect(custody.ledger[1]).toMatchObject({ reason: "COMPOUND_CONSUMED", quantityDelta: "-30" });
    expect(custody.dispensed).toEqual([
      {
        lotAssignmentId: "assign-1",
        orderId: "order-1",
        orderLineId: "line-2",
        assignedByUserId: USER_ID,
        assignedAt: "2026-08-01T14:00:00.000Z",
      },
    ]);
    expect(custody.compounded).toEqual([
      {
        compoundingRecordId: "cr-1",
        orderId: "order-1",
        orderLineId: "line-1",
        formulaCode: "MAGIC-MOUTHWASH",
        formulaVersion: 2,
        preparedAt: "2026-08-01T13:00:00.000Z",
        quantity: "30",
      },
    ]);

    // PHI-safety: ids and supply-chain data only.
    const serialized = JSON.stringify(custody);
    expect(serialized).not.toMatch(/patient/i);
  });

  it("throws a typed NotFound for a lot outside the org", async () => {
    await expect(
      getLotChainOfCustody({
        tx: buildCustodyFake({ lotExists: false }),
        organizationId: ORG_ID,
        lotId: LOT_ID,
      })
    ).rejects.toMatchObject({ code: "INVENTORY_LOT_NOT_FOUND" });
  });
});
