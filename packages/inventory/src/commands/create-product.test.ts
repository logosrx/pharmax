// Contract tests for CreateProduct (typing-assist phase 1 — product
// CRUD write surface).
//
// Invariants under test:
//   1. Happy path: creates the catalog row org-scoped, audits every
//      field, emits inventory.product.created.v1.
//   2. Defaults: ndcKind NATIONAL, schedule NON_CONTROLLED — the
//      conservative directions documented on the schema.
//   3. Duplicate NDC in the same org (P2002) is a typed conflict.
//   4. RBAC: inventory.receive alone cannot create a product — the
//      catalog write surface is its own grant.
//
// All data is synthetic. No PHI.

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

import { CreateProduct } from "./create-product.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const managerGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_PRODUCTS_MANAGE]),
  },
];

const receiveOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_RECEIVE, PERMISSIONS.INVENTORY_READ]),
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
    ndc: "00000-1111-22",
    name: "Fake Semaglutide Injection",
    strength: "2.5 mg/mL",
    form: "Injectable solution",
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
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "create", args });
        if (opts.productCreateError !== undefined) throw opts.productCreateError;
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
        calls.push({ table: "$executeRaw", op: "raw", args: { sql: template.join("?"), values } });
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

function findOnly(calls: FakeCall[], table: string, op: string): FakeCall {
  const m = calls.filter((c) => c.table === table && c.op === op);
  if (m.length !== 1) {
    throw new Error(`Expected exactly one ${table}.${op}, got ${m.length}`);
  }
  return m[0] as FakeCall;
}

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = managerGrants
): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-16T12:00:00.000Z")),
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
// Tests
// ---------------------------------------------------------------------

describe("CreateProduct — happy path", () => {
  it("creates the org-scoped catalog row with conservative defaults and audits every field", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateProduct, validInput(), { idempotencyKey: "create-product-1" })
    );

    expect(out.ndc).toBe("00000-1111-22");
    expect(out.ndcKind).toBe("NATIONAL");
    expect(out.controlledSubstanceSchedule).toBe("NON_CONTROLLED");

    const created = (
      findOnly(fake.calls, "product", "create").args as { data: Record<string, unknown> }
    ).data;
    expect(created).toMatchObject({
      id: out.productId,
      organizationId: ORG_ID,
      ndc: "00000-1111-22",
      name: "Fake Semaglutide Injection",
      strength: "2.5 mg/mL",
      form: "Injectable solution",
      ndcKind: "NATIONAL",
      controlledSubstanceSchedule: "NON_CONTROLLED",
    });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.product.created");
    expect(audit.metadata).toMatchObject({
      ndc: "00000-1111-22",
      ndcKind: "NATIONAL",
      controlledSubstanceSchedule: "NON_CONTROLLED",
    });

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany").args as {
      data: Array<Record<string, unknown>>;
    };
    expect(outbox.data[0]).toMatchObject({ eventType: "inventory.product.created.v1" });
  });

  it("accepts explicit ndcKind and schedule for an in-house controlled compound", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateProduct,
        {
          ...validInput(),
          ndc: "COMPOUND-0001",
          ndcKind: "IN_HOUSE_COMPOUND" as const,
          controlledSubstanceSchedule: "CIII" as const,
        },
        { idempotencyKey: "create-product-2" }
      )
    );
    expect(out.ndcKind).toBe("IN_HOUSE_COMPOUND");
    expect(out.controlledSubstanceSchedule).toBe("CIII");
  });
});

describe("CreateProduct — refusals", () => {
  it("maps a duplicate (org, ndc) P2002 to a typed conflict", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildFakePrisma({ productCreateError: p2002 });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateProduct, validInput(), { idempotencyKey: "create-product-dup" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_PRODUCT_NDC_CONFLICT" });
  });

  it("denies a user holding only inventory.receive", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, receiveOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateProduct, validInput(), { idempotencyKey: "create-product-rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(fake.calls.filter((c) => c.table === "product")).toHaveLength(0);
  });
});
