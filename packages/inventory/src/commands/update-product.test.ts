// Contract tests for UpdateProduct (typing-assist phase 1 — product
// CRUD write surface).
//
// Invariants under test:
//   1. Happy path: patches only the changed fields, audits
//      before/after on the screening-relevant switches (ndcKind,
//      controlledSubstanceSchedule), emits
//      inventory.product.updated.v1 with changedFields.
//   2. The ndcKind flip NATIONAL → IN_HOUSE_COMPOUND — the
//      screening-suppression vector — lands in the audit row with
//      both values.
//   3. A no-op update is a typed refusal, not a fabricated audit row.
//   4. Product must resolve in THIS org — typed NotFound.
//   5. RBAC: read-only inventory grants cannot update.
//
// All data is synthetic. No PHI.

import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleScope } from "@pharmax/database";
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

import { UpdateProduct } from "./update-product.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";

const managerGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_PRODUCTS_MANAGE]),
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

const EXISTING_PRODUCT = {
  id: PRODUCT_ID,
  ndc: "00000-1111-22",
  name: "Fake Semaglutide Injection",
  strength: "2.5 mg/mL",
  form: "Injectable solution",
  ndcKind: "NATIONAL",
  controlledSubstanceSchedule: "NON_CONTROLLED",
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
  /** When false, product.findFirst returns null. */
  productExists?: boolean;
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
        return (opts.productExists ?? true) ? { ...EXISTING_PRODUCT } : null;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "update", args });
        return { id: PRODUCT_ID };
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

describe("UpdateProduct — happy path", () => {
  it("patches only changed fields and records the ndcKind flip with before/after", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProduct,
        {
          productId: PRODUCT_ID,
          // Same name as stored — must NOT appear in the patch.
          name: "Fake Semaglutide Injection",
          ndcKind: "IN_HOUSE_COMPOUND" as const,
        },
        { idempotencyKey: "update-product-1" }
      )
    );

    expect(out.ndcKind).toBe("IN_HOUSE_COMPOUND");

    const patch = (
      findOnly(fake.calls, "product", "update").args as { data: Record<string, unknown> }
    ).data;
    expect(patch).toEqual({ ndcKind: "IN_HOUSE_COMPOUND" });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.product.updated");
    expect(audit.metadata).toMatchObject({
      ndcKindBefore: "NATIONAL",
      ndcKindAfter: "IN_HOUSE_COMPOUND",
      changedFields: ["ndcKind"],
    });

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany").args as {
      data: Array<Record<string, unknown>>;
    };
    expect(outbox.data[0]).toMatchObject({ eventType: "inventory.product.updated.v1" });
  });

  it("records a schedule change with before/after values", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProduct,
        { productId: PRODUCT_ID, controlledSubstanceSchedule: "CII" as const },
        { idempotencyKey: "update-product-2" }
      )
    );

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.metadata).toMatchObject({
      controlledSubstanceScheduleBefore: "NON_CONTROLLED",
      controlledSubstanceScheduleAfter: "CII",
    });
  });
});

describe("UpdateProduct — refusals", () => {
  it("refuses a no-op update instead of fabricating an audit row", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateProduct,
          { productId: PRODUCT_ID, name: "Fake Semaglutide Injection" },
          { idempotencyKey: "update-product-noop" }
        )
      )
    ).rejects.toMatchObject({ code: "INVENTORY_PRODUCT_NO_CHANGES" });

    expect(fake.calls.filter((c) => c.table === "product" && c.op === "update")).toHaveLength(0);
  });

  it("rejects a product missing from this org's catalog", async () => {
    const fake = buildFakePrisma({ productExists: false });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateProduct,
          { productId: PRODUCT_ID, name: "New Name" },
          { idempotencyKey: "update-product-404" }
        )
      )
    ).rejects.toMatchObject({ code: "INVENTORY_PRODUCT_NOT_FOUND" });
  });

  it("denies a user holding only inventory.read", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateProduct,
          { productId: PRODUCT_ID, name: "New Name" },
          { idempotencyKey: "update-product-rbac" }
        )
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
});
