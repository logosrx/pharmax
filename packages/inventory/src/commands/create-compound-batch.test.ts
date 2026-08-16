// Contract tests for CreateCompoundBatch.
//
// Invariants under test:
//   1. Creation mints the batch number from the SITE code + the
//      PRODUCT's frozen serial identity + the batch-of-the-day counter
//      + the compounding date, and mints one serial row per unit;
//      audit + outbox event written.
//   2. The batch-of-the-day counter is COUNT+1 over this
//      (site, product, day) — a second batch the same day is "-2".
//   3. A batch cannot be created for a NATIONAL (manufactured)
//      product, nor for a compound with no serial identity on file.
//   4. A BUD on or before the compounding date is refused before any
//      write.
//   5. A P2002 (concurrent creation took this day-sequence) is a typed
//      retryable conflict.
//   6. RBAC denial leaves zero command_log footprint.

import { afterEach, describe, expect, it, vi } from "vitest";

import { Prisma, RoleScope } from "@pharmax/database";
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

import { CreateCompoundBatch } from "./create-compound-batch.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";

const creatorGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_BATCH_CREATE]),
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
    unitCount: 40,
    compoundedOn: "2027-04-03",
    beyondUseDate: "2027-07-02",
  };
}

const compoundProduct = {
  id: PRODUCT_ID,
  name: "Tirzepatide/Glycine",
  strength: "10mg/20mg/3mL",
  ndcKind: "IN_HOUSE_COMPOUND",
  pharmaxProductId: "PXP-000042",
  serialDrugInitial: "T",
  serialDrugMg: 30,
  unitKind: "VIAL",
};

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** Row returned by pharmacySite.findFirst. */
  site?: { id: string; code: string } | null;
  /** Row returned by product.findFirst. */
  product?: Record<string, unknown> | null;
  /** Batches already recorded for this (site, product, day). */
  priorToday?: number;
  /** When set, compoundBatch.create throws this. */
  batchCreateError?: Error;
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
        return opts.site === undefined ? { id: SITE_ID, code: "PHX" } : opts.site;
      }),
    },
    product: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findFirst", args });
        return opts.product === undefined ? compoundProduct : opts.product;
      }),
    },
    compoundBatch: {
      count: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatch", op: "count", args });
        return opts.priorToday ?? 0;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatch", op: "create", args });
        if (opts.batchCreateError !== undefined) throw opts.batchCreateError;
        return (args as { data: { id: string } }).data;
      }),
    },
    compoundBatchUnit: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatchUnit", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
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
        return { count: (args as { data: unknown[] }).data.length };
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
  grants: ReadonlyArray<ResolvedGrant> = creatorGrants
): void {
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

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

describe("CreateCompoundBatch — creation", () => {
  it("mints the batch number from site + product identity + day sequence + date, and one serial per unit", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-1" })
    );

    expect(out.batchNumber).toBe("PHX-T30-1-040327");
    expect(out.daySequence).toBe(1);
    expect(out.unitCount).toBe(40);
    expect(out.firstSerial).toBe("PHX-T30-1-040327-1");
    expect(out.lastSerial).toBe("PHX-T30-1-040327-40");
    expect(out.barcodeValue).toBe("PXB:PXP-000042:PHX-T30-1-040327");

    const batch = (
      findOnly(fake.calls, "compoundBatch", "create").args as { data: Record<string, unknown> }
    ).data;
    expect(batch).toMatchObject({
      id: out.batchId,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      productId: PRODUCT_ID,
      batchNumber: "PHX-T30-1-040327",
      daySequence: 1,
      unitCount: 40,
      barcodeValue: "PXB:PXP-000042:PHX-T30-1-040327",
      createdByUserId: USER_ID,
    });
    // Status is not set by the handler — the schema default puts every
    // new batch in COMPOUNDED.
    expect(batch["status"]).toBeUndefined();

    // One serial row per unit, numbered 1..n.
    const units = (
      findOnly(fake.calls, "compoundBatchUnit", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(units).toHaveLength(40);
    expect(units[0]).toMatchObject({
      organizationId: ORG_ID,
      batchId: out.batchId,
      unitNumber: 1,
      serialNumber: "PHX-T30-1-040327-1",
    });
    expect(units[39]).toMatchObject({
      unitNumber: 40,
      serialNumber: "PHX-T30-1-040327-40",
    });

    const events = outboxPayloads(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "inventory.compound_batch.created.v1" });
    expect(events[0]?.["payload"]).toMatchObject({
      organizationId: ORG_ID,
      batchId: out.batchId,
      siteId: SITE_ID,
      productId: PRODUCT_ID,
      pharmaxProductId: "PXP-000042",
      batchNumber: "PHX-T30-1-040327",
      daySequence: 1,
      compoundedOn: "2027-04-03",
      beyondUseDate: "2027-07-02",
      unitCount: 40,
      createdByUserId: USER_ID,
    });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.compound_batch.created");
    expect(audit.metadata).toMatchObject({
      batchNumber: "PHX-T30-1-040327",
      unitCount: 40,
      beyondUseDate: "2027-07-02",
    });
  });

  it("increments the batch-of-the-day counter for a second same-day run", async () => {
    const fake = buildFakePrisma({ priorToday: 1 });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-2" })
    );

    expect(out.daySequence).toBe(2);
    expect(out.batchNumber).toBe("PHX-T30-2-040327");
    expect(out.firstSerial).toBe("PHX-T30-2-040327-1");

    // The counter is scoped to (org, site, product, day) — not org-wide.
    expect(findOnly(fake.calls, "compoundBatch", "count").args).toMatchObject({
      where: { organizationId: ORG_ID, siteId: SITE_ID, productId: PRODUCT_ID },
    });
  });

  it("normalizes a site code that would otherwise corrupt the serial delimiter", async () => {
    const fake = buildFakePrisma({ site: { id: SITE_ID, code: "ph-x" } });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-sitecode" })
    );

    expect(out.batchNumber).toBe("PHX-T30-1-040327");
  });
});

// ---------------------------------------------------------------------
// Product eligibility
// ---------------------------------------------------------------------

describe("CreateCompoundBatch — product eligibility", () => {
  it("refuses a manufactured (NATIONAL) product — that stock arrives through DSCSA receiving", async () => {
    const fake = buildFakePrisma({
      product: {
        ...compoundProduct,
        ndcKind: "NATIONAL",
        pharmaxProductId: null,
      },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-national" })
      )
    ).rejects.toMatchObject({ code: "BATCH_PRODUCT_NOT_COMPOUND" });

    expect(callsOf(fake.calls, "compoundBatch", "create")).toHaveLength(0);
  });

  it("refuses a compound with no serial identity on file", async () => {
    const fake = buildFakePrisma({
      product: { ...compoundProduct, serialDrugInitial: null, serialDrugMg: null },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-no-serial" })
      )
    ).rejects.toMatchObject({ code: "BATCH_PRODUCT_SERIAL_IDENTITY_MISSING" });

    expect(callsOf(fake.calls, "compoundBatch", "create")).toHaveLength(0);
  });

  it("refuses an unknown site", async () => {
    const fake = buildFakePrisma({ site: null });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-no-site" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_SITE_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------
// BUD validation
// ---------------------------------------------------------------------

describe("CreateCompoundBatch — Beyond-Use Date", () => {
  it("refuses a BUD equal to the compounding date (expired at birth) before any read", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundBatch,
          { ...validInput(), beyondUseDate: "2027-04-03" },
          { idempotencyKey: "batch-bud-same" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_BUD_NOT_AFTER_COMPOUNDING" });

    expect(callsOf(fake.calls, "compoundBatch", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "pharmacySite", "findFirst")).toHaveLength(0);
  });

  it("refuses a BUD before the compounding date", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundBatch,
          { ...validInput(), beyondUseDate: "2027-04-02" },
          { idempotencyKey: "batch-bud-before" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_BUD_NOT_AFTER_COMPOUNDING" });
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

describe("CreateCompoundBatch — input validation", () => {
  it("refuses a zero unit count before any write", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundBatch,
          { ...validInput(), unitCount: 0 },
          { idempotencyKey: "batch-zero-units" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });

    expect(callsOf(fake.calls, "compoundBatch", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------

describe("CreateCompoundBatch — day-sequence race", () => {
  it("surfaces a P2002 as a typed retryable conflict rather than two batches sharing a serial prefix", async () => {
    const fake = buildFakePrisma({
      batchCreateError: new Prisma.PrismaClientKnownRequestError("duplicate key", {
        code: "P2002",
        clientVersion: "test",
      }),
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-p2002" })
      )
    ).rejects.toMatchObject({
      code: "BATCH_CREATE_CONFLICT",
      metadata: { batchNumber: "PHX-T30-1-040327" },
    });
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("CreateCompoundBatch — RBAC", () => {
  it("denies a user without inventory.batch.create and leaves no command_log footprint", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundBatch, validInput(), { idempotencyKey: "batch-rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "compoundBatch", "create")).toHaveLength(0);
  });
});
