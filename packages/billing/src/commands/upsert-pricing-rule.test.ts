// UpsertPricingRule contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { InvoiceLineKind, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  UPSERT_PRICING_RULE_CLINIC_NOT_FOUND,
  UPSERT_PRICING_RULE_PRODUCT_NOT_FOUND,
  UpsertPricingRule,
} from "./upsert-pricing-rule.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const PRODUCT_ID = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_MANAGE_PRICING]),
  },
];

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakeOverrides {
  priorActive?: { id: string } | null;
  clinic?: { id: string; organizationId: string } | null;
  product?: { id: string; organizationId: string } | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    clinic: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findUnique", args });
        return overrides.clinic === undefined
          ? { id: CLINIC_ID, organizationId: ORG_ID }
          : overrides.clinic;
      }),
    },
    product: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findUnique", args });
        return overrides.product === undefined
          ? { id: PRODUCT_ID, organizationId: ORG_ID }
          : overrides.product;
      }),
    },
    pricingRule: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pricingRule", op: "findFirst", args });
        return overrides.priorActive ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "pricingRule", op: "update", args });
        return { id: "u" };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "pricingRule", op: "create", args });
        return { id: "c" };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al" };
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
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T18:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

const ctxFor = () =>
  buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("UpsertPricingRule — first rule for the scope", () => {
  it("creates the rule, no prior to supersede", async () => {
    const fake = buildPrismaFake({ priorActive: null });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        UpsertPricingRule,
        {
          clinicId: null,
          productId: null,
          kind: InvoiceLineKind.DISPENSE_FEE,
          unitAmountCents: 7500,
        },
        { idempotencyKey: "upsert-1" }
      )
    );

    expect(out.supersededRuleId).toBeNull();
    expect(out.unitAmountCents).toBe(7500);
    expect(fake.calls.filter((c) => c.table === "pricingRule" && c.op === "update")).toHaveLength(
      0
    );
    expect(fake.calls.filter((c) => c.table === "pricingRule" && c.op === "create")).toHaveLength(
      1
    );

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData[0]?.eventType).toBe("billing.pricing_rule.upserted.v1");
  });
});

describe("UpsertPricingRule — supersedure", () => {
  it("transitions the prior ACTIVE rule to SUPERSEDED before inserting the new one", async () => {
    const fake = buildPrismaFake({ priorActive: { id: "prior-rule-1" } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        UpsertPricingRule,
        {
          clinicId: CLINIC_ID,
          productId: null,
          kind: InvoiceLineKind.DISPENSE_FEE,
          unitAmountCents: 8000,
        },
        { idempotencyKey: "upsert-supersede" }
      )
    );

    expect(out.supersededRuleId).toBe("prior-rule-1");

    const updates = fake.calls.filter((c) => c.table === "pricingRule" && c.op === "update");
    expect(updates).toHaveLength(1);
    const updateArgs = updates[0]!.args as { where: { id: string }; data: Record<string, unknown> };
    expect(updateArgs.where.id).toBe("prior-rule-1");
    expect(updateArgs.data["status"]).toBe("SUPERSEDED");
    expect(updateArgs.data["effectiveTo"]).toBeInstanceOf(Date);
  });
});

describe("UpsertPricingRule — scope validation", () => {
  it("throws when clinic does not belong to the org", async () => {
    const fake = buildPrismaFake({
      clinic: { id: CLINIC_ID, organizationId: OTHER_ORG_ID },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          UpsertPricingRule,
          {
            clinicId: CLINIC_ID,
            productId: null,
            kind: InvoiceLineKind.DISPENSE_FEE,
            unitAmountCents: 5000,
          },
          { idempotencyKey: "upsert-bad-clinic" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_PRICING_RULE_CLINIC_NOT_FOUND });
  });

  it("throws when product does not belong to the org", async () => {
    const fake = buildPrismaFake({
      product: { id: PRODUCT_ID, organizationId: OTHER_ORG_ID },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          UpsertPricingRule,
          {
            clinicId: null,
            productId: PRODUCT_ID,
            kind: InvoiceLineKind.DISPENSE_FEE,
            unitAmountCents: 5000,
          },
          { idempotencyKey: "upsert-bad-product" }
        )
      )
    ).rejects.toMatchObject({ code: UPSERT_PRICING_RULE_PRODUCT_NOT_FOUND });
  });
});
