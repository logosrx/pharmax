// Contract tests for SetProductAiGuardrail (typing-assist phase 1).
//
// Invariants under test:
//   1. First revision creates the row at version 1 with the tenant's
//      ceilings; audit carries before=null and the full after.
//   2. Second revision CAS-bumps the version and audits before/after.
//   3. A concurrent revision (CAS miss) is a typed conflict.
//   4. Product must resolve in THIS org — typed NotFound.
//   5. RBAC: the guardrail rides inventory.products.manage; a
//      receive-only user is denied.
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

import { SetProductAiGuardrail } from "./set-product-ai-guardrail.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";
const GUARDRAIL_ID = "66666666-6666-4666-8666-666666666666";

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
    permissions: new Set([PERMISSIONS.INVENTORY_RECEIVE]),
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
    productId: PRODUCT_ID,
    aiSuggestionsEnabled: true,
    maxQuantityPerFill: 90,
    maxDaysSupplyPerFill: 30,
    maxRefillsAuthorized: 5,
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
  /** When false, product.findFirst returns null. */
  productExists?: boolean;
  /** Row returned by productAiGuardrail.findFirst. Default: none. */
  existingGuardrail?: {
    id: string;
    version: number;
    aiSuggestionsEnabled: boolean;
    maxQuantityPerFill: Prisma.Decimal | null;
    maxDaysSupplyPerFill: number | null;
    maxRefillsAuthorized: number | null;
  } | null;
  /** updateMany result count. Default 1. */
  updateManyCount?: number;
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
        return (opts.productExists ?? true)
          ? {
              id: PRODUCT_ID,
              ndc: "00000-1111-22",
              controlledSubstanceSchedule: "NON_CONTROLLED",
            }
          : null;
      }),
    },
    productAiGuardrail: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "productAiGuardrail", op: "findFirst", args });
        return opts.existingGuardrail ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "productAiGuardrail", op: "create", args });
        return (args as { data: { id: string } }).data;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "productAiGuardrail", op: "updateMany", args });
        return { count: opts.updateManyCount ?? 1 };
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

describe("SetProductAiGuardrail — first revision", () => {
  it("creates the guardrail at version 1 and audits before=null", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SetProductAiGuardrail, validInput(), { idempotencyKey: "guardrail-1" })
    );

    expect(out.created).toBe(true);
    expect(out.version).toBe(1);
    expect(out.productId).toBe(PRODUCT_ID);

    const created = (
      findOnly(fake.calls, "productAiGuardrail", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(created).toMatchObject({
      id: out.guardrailId,
      organizationId: ORG_ID,
      productId: PRODUCT_ID,
      aiSuggestionsEnabled: true,
      maxDaysSupplyPerFill: 30,
      maxRefillsAuthorized: 5,
    });
    expect((created["maxQuantityPerFill"] as Prisma.Decimal).toString()).toBe("90");

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.product_ai_guardrail.created");
    expect(audit.metadata["before"]).toBeNull();
    expect(audit.metadata["after"]).toMatchObject({
      aiSuggestionsEnabled: true,
      maxQuantityPerFill: 90,
    });

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany").args as {
      data: Array<Record<string, unknown>>;
    };
    expect(outbox.data[0]).toMatchObject({
      eventType: "inventory.product_ai_guardrail.set.v1",
    });
  });
});

describe("SetProductAiGuardrail — revision", () => {
  const existing = {
    id: GUARDRAIL_ID,
    version: 3,
    aiSuggestionsEnabled: true,
    maxQuantityPerFill: new Prisma.Decimal(90),
    maxDaysSupplyPerFill: 30,
    maxRefillsAuthorized: 5,
  };

  it("CAS-bumps the version and audits before/after", async () => {
    const fake = buildFakePrisma({ existingGuardrail: existing });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        SetProductAiGuardrail,
        { ...validInput(), aiSuggestionsEnabled: false, maxQuantityPerFill: null },
        { idempotencyKey: "guardrail-2" }
      )
    );

    expect(out.created).toBe(false);
    expect(out.version).toBe(4);

    const update = findOnly(fake.calls, "productAiGuardrail", "updateMany").args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id: GUARDRAIL_ID, version: 3 });
    expect(update.data).toMatchObject({
      aiSuggestionsEnabled: false,
      maxQuantityPerFill: null,
      version: 4,
    });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.product_ai_guardrail.revised");
    expect(audit.metadata["before"]).toMatchObject({
      aiSuggestionsEnabled: true,
      maxQuantityPerFill: "90",
    });
    expect(audit.metadata["after"]).toMatchObject({
      aiSuggestionsEnabled: false,
      maxQuantityPerFill: null,
    });
  });

  it("maps a CAS miss to a typed conflict", async () => {
    const fake = buildFakePrisma({ existingGuardrail: existing, updateManyCount: 0 });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetProductAiGuardrail, validInput(), { idempotencyKey: "guardrail-cas" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_GUARDRAIL_CONFLICT" });
  });
});

describe("SetProductAiGuardrail — refusals", () => {
  it("rejects a product missing from this org's catalog", async () => {
    const fake = buildFakePrisma({ productExists: false });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetProductAiGuardrail, validInput(), { idempotencyKey: "guardrail-404" })
      )
    ).rejects.toMatchObject({ code: "INVENTORY_PRODUCT_NOT_FOUND" });
  });

  it("denies a user holding only inventory.receive", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, receiveOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetProductAiGuardrail, validInput(), { idempotencyKey: "guardrail-rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(fake.calls.filter((c) => c.table === "productAiGuardrail")).toHaveLength(0);
  });
});
