// Contract tests for CreateCompoundProduct.
//
// Invariants under test:
//   1. Creation mints the org's next Pharmax Product ID inside the
//      transaction, mirrors it into `ndc` (the org-local identifier
//      slot for compounds), fixes `ndcKind = IN_HOUSE_COMPOUND`, and
//      freezes the serial identity; audit + outbox event written.
//   2. The serial initial is normalized to uppercase.
//   3. A same-name (case-insensitive) + same-strength compound is a
//      typed conflict naming the existing product — no second mint.
//   4. Input validation refuses a multi-letter initial and a
//      non-positive mg BEFORE any write.
//   5. A P2002 on product.create (hand-reset sequence) is a typed
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

import { CreateCompoundProduct } from "./create-compound-product.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const EXISTING_PRODUCT_ID = "44444444-4444-4444-8444-444444444444";

const creatorGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.CATALOG_COMPOUND_PRODUCT_CREATE]),
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
    name: "Tirzepatide/Glycine",
    strength: "10mg/20mg/3mL",
    form: "Injectable solution",
    unitKind: "VIAL",
    serialDrugInitial: "t",
    serialDrugMg: 30,
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
  /** Row returned by product.findFirst (duplicate guard). */
  duplicate?: { id: string; pharmaxProductId: string | null } | null;
  /** Counter value returned by the allocator upsert. */
  nextSequenceValue?: number;
  /** When set, product.create throws this. */
  productCreateError?: Error;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    product: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findFirst", args });
        return opts.duplicate ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "create", args });
        if (opts.productCreateError !== undefined) throw opts.productCreateError;
        return (args as { data: { id: string } }).data;
      }),
    },
    pharmaxProductIdSequence: {
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmaxProductIdSequence", op: "upsert", args });
        return { lastValue: opts.nextSequenceValue ?? 7 };
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
  grants: ReadonlyArray<ResolvedGrant> = creatorGrants
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
// Happy path
// ---------------------------------------------------------------------

describe("CreateCompoundProduct — creation", () => {
  it("mints the Pharmax Product ID, mirrors it into ndc, freezes the serial identity, and emits the event", async () => {
    const fake = buildFakePrisma({ nextSequenceValue: 42 });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundProduct, validInput(), { idempotencyKey: "compound-1" })
    );

    expect(out.pharmaxProductId).toBe("PXP-000042");
    expect(out.name).toBe("Tirzepatide/Glycine");
    expect(out.strength).toBe("10mg/20mg/3mL");

    // The allocator ran inside the transaction, scoped to the org.
    const alloc = findOnly(fake.calls, "pharmaxProductIdSequence", "upsert");
    expect(alloc.args).toMatchObject({ where: { organizationId: ORG_ID } });

    const product = (
      findOnly(fake.calls, "product", "create").args as { data: Record<string, unknown> }
    ).data;
    expect(product).toMatchObject({
      id: out.productId,
      organizationId: ORG_ID,
      // The minted id IS the org-local identifier in `ndc`.
      ndc: "PXP-000042",
      pharmaxProductId: "PXP-000042",
      name: "Tirzepatide/Glycine",
      strength: "10mg/20mg/3mL",
      form: "Injectable solution",
      ndcKind: "IN_HOUSE_COMPOUND",
      unitKind: "VIAL",
      // Lowercase input, uppercase serial — the letter prints on labels.
      serialDrugInitial: "T",
      serialDrugMg: 30,
    });

    const events = outboxPayloads(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "catalog.compound_product.created.v1" });
    const payload = events[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      productId: out.productId,
      pharmaxProductId: "PXP-000042",
      name: "Tirzepatide/Glycine",
      strength: "10mg/20mg/3mL",
      unitKind: "VIAL",
      serialDrugInitial: "T",
      serialDrugMg: 30,
      createdByUserId: USER_ID,
    });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("catalog.compound_product.created");
    expect(audit.metadata).toMatchObject({
      pharmaxProductId: "PXP-000042",
      serialDrugInitial: "T",
      serialDrugMg: 30,
      controlledSubstanceSchedule: "NON_CONTROLLED",
    });
  });
});

// ---------------------------------------------------------------------
// Duplicate guard
// ---------------------------------------------------------------------

describe("CreateCompoundProduct — duplicate guard", () => {
  it("refuses a same-name same-strength compound, naming the existing product, before any mint", async () => {
    const fake = buildFakePrisma({
      duplicate: { id: EXISTING_PRODUCT_ID, pharmaxProductId: "PXP-000007" },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundProduct, validInput(), { idempotencyKey: "compound-dup" })
      )
    ).rejects.toMatchObject({
      code: "CATALOG_DUPLICATE_COMPOUND_PRODUCT",
      metadata: {
        existingProductId: EXISTING_PRODUCT_ID,
        existingPharmaxProductId: "PXP-000007",
      },
    });

    // No id was consumed and no row written.
    expect(callsOf(fake.calls, "pharmaxProductIdSequence", "upsert")).toHaveLength(0);
    expect(callsOf(fake.calls, "product", "create")).toHaveLength(0);
  });

  it("matches the duplicate case-insensitively on name", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateCompoundProduct,
        { ...validInput(), name: "TIRZEPATIDE/GLYCINE" },
        { idempotencyKey: "compound-ci" }
      )
    );

    const guard = findOnly(fake.calls, "product", "findFirst").args as {
      where: { name: Record<string, unknown> };
    };
    expect(guard.where.name).toEqual({ equals: "TIRZEPATIDE/GLYCINE", mode: "insensitive" });
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

describe("CreateCompoundProduct — input validation", () => {
  it("refuses a multi-letter serial initial before any write", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundProduct,
          { ...validInput(), serialDrugInitial: "TZ" },
          { idempotencyKey: "compound-bad-initial" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });

    expect(callsOf(fake.calls, "product", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "pharmaxProductIdSequence", "upsert")).toHaveLength(0);
  });

  it("refuses a non-positive serial mg before any write", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundProduct,
          { ...validInput(), serialDrugMg: 0 },
          { idempotencyKey: "compound-bad-mg" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });

    expect(callsOf(fake.calls, "product", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Concurrency / conflict
// ---------------------------------------------------------------------

describe("CreateCompoundProduct — id collision", () => {
  it("surfaces a P2002 on product.create as a typed retryable conflict", async () => {
    const fake = buildFakePrisma({
      productCreateError: new Prisma.PrismaClientKnownRequestError("duplicate key", {
        code: "P2002",
        clientVersion: "test",
      }),
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundProduct, validInput(), { idempotencyKey: "compound-p2002" })
      )
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_CREATE_CONFLICT" });
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("CreateCompoundProduct — RBAC", () => {
  it("denies a user without catalog.compound_product.create and leaves no command_log footprint", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundProduct, validInput(), { idempotencyKey: "compound-rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "product", "create")).toHaveLength(0);
  });
});
