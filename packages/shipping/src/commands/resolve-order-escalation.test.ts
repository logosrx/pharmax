// ResolveOrderEscalation contract tests.
//
// Surface:
//   - RETURN_TO_SHIPPING happy path: order moves from EMERGENCY → SHIPPING,
//     CAS bumps version, emits `order.escalation_resolved.v1`.
//   - RETURN_TO_FILL happy path: same shape, target is FILL.
//   - KEEP_IN_EMERGENCY: audit-only, no mutation, no CAS, emits
//     `order.escalation_acknowledged.v1`.
//   - Order NOT in EMERGENCY → RESOLVE_ESCALATION_NOT_IN_EMERGENCY.
//   - EMERGENCY bucket missing (deleted/never seeded) → same conflict
//     guard (treats "no emergency exists" same as "order is not in it").
//   - Target bucket missing → RESOLVE_ESCALATION_TARGET_BUCKET_NOT_FOUND.
//   - PHI invariant: reasonText is redacted from audit + outbox; only a
//     boolean `hasReasonText` survives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { BucketKind, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  RESOLVE_ESCALATION_NOT_IN_EMERGENCY,
  RESOLVE_ESCALATION_TARGET_BUCKET_NOT_FOUND,
  ResolveOrderEscalation,
} from "./resolve-order-escalation.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const EMERGENCY_BUCKET_ID = "00000000-0000-4000-8000-000000000eee";
const SHIPPING_BUCKET_ID = "00000000-0000-4000-8000-000000000b06";
const FILL_BUCKET_ID = "00000000-0000-4000-8000-000000000b04";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_RESOLVE_ESCALATION]),
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
  /** Locked-row payload. Defaults to "order currently in EMERGENCY". */
  lockedRow?: { currentBucketId: string; version: number } | null;
  /** Bucket lookup map by code. Default: EMERGENCY + SHIPPING + FILL all present. */
  buckets?: Partial<Record<string, { id: string; kind: BucketKind } | null>>;
  /** CAS hit count returned by `order.updateMany`. Default 1. */
  orderUpdateManyCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentBucketId: EMERGENCY_BUCKET_ID, version: 5 }
      : overrides.lockedRow;
  const buckets: Record<string, { id: string; kind: BucketKind } | null> = {
    EMERGENCY: { id: EMERGENCY_BUCKET_ID, kind: BucketKind.EMERGENCY },
    SHIPPING: { id: SHIPPING_BUCKET_ID, kind: BucketKind.WORKFLOW },
    FILL: { id: FILL_BUCKET_ID, kind: BucketKind.WORKFLOW },
    ...overrides.buckets,
  };
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;

  const tx = {
    bucket: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findUnique", args });
        const w = (args as { where: { organizationId_code: { code: string } } }).where
          .organizationId_code.code;
        return buckets[w] ?? null;
      }),
    },
    order: {
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe" };
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
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
    $queryRaw: vi.fn(async (template: TemplateStringsArray) => {
      const joined = template.join("?");
      if (/FROM\s+"?order"?/i.test(joined) && /FOR\s+UPDATE/i.test(joined)) {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                clinicId: CLINIC_ID,
                siteId: SITE_ID,
                currentBucketId: lockedRow.currentBucketId,
                currentStatus: "SHIPPED",
                version: lockedRow.version,
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
              },
            ];
      }
      return [];
    }),
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
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T16:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ResolveOrderEscalation — disposition: RETURN_TO_SHIPPING", () => {
  it("moves the order from EMERGENCY to SHIPPING, CAS-bumps version, emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolveOrderEscalation,
        { orderId: ORDER_ID, disposition: "RETURN_TO_SHIPPING" as const },
        { idempotencyKey: "resolve-1" }
      )
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      disposition: "RETURN_TO_SHIPPING",
      previousBucketId: EMERGENCY_BUCKET_ID,
      newBucketId: SHIPPING_BUCKET_ID,
      bucketUnchanged: false,
      version: 6,
    });

    const updates = fake.calls.filter((c) => c.table === "order" && c.op === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0]!.args as { data: { currentBucketId: string } }).data.currentBucketId).toBe(
      SHIPPING_BUCKET_ID
    );

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("order.escalation_resolved.v1");
    expect(outboxData[0]?.payload["targetBucketCode"]).toBe("SHIPPING");
  });
});

describe("ResolveOrderEscalation — disposition: RETURN_TO_FILL", () => {
  it("moves the order from EMERGENCY to FILL", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolveOrderEscalation,
        { orderId: ORDER_ID, disposition: "RETURN_TO_FILL" as const },
        { idempotencyKey: "resolve-2" }
      )
    );

    expect(out.newBucketId).toBe(FILL_BUCKET_ID);
    expect(out.disposition).toBe("RETURN_TO_FILL");
  });
});

describe("ResolveOrderEscalation — disposition: KEEP_IN_EMERGENCY", () => {
  it("writes audit + outbox but does not mutate the order or CAS the version", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolveOrderEscalation,
        { orderId: ORDER_ID, disposition: "KEEP_IN_EMERGENCY" as const },
        { idempotencyKey: "resolve-3" }
      )
    );

    expect(out).toMatchObject({
      bucketUnchanged: true,
      previousBucketId: EMERGENCY_BUCKET_ID,
      newBucketId: EMERGENCY_BUCKET_ID,
      version: 5,
    });

    expect(fake.calls.filter((c) => c.table === "order" && c.op === "update")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.table === "order" && c.op === "updateMany")).toHaveLength(0);

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData[0]?.eventType).toBe("order.escalation_acknowledged.v1");
  });
});

describe("ResolveOrderEscalation — guards", () => {
  it("rejects when the order is not currently in EMERGENCY", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentBucketId: SHIPPING_BUCKET_ID, version: 5 },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ResolveOrderEscalation,
          { orderId: ORDER_ID, disposition: "RETURN_TO_SHIPPING" as const },
          { idempotencyKey: "resolve-not-in-em" }
        )
      )
    ).rejects.toMatchObject({ code: RESOLVE_ESCALATION_NOT_IN_EMERGENCY });
  });

  it("rejects when EMERGENCY bucket itself is missing (treats as 'not in emergency')", async () => {
    const fake = buildPrismaFake({ buckets: { EMERGENCY: null } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ResolveOrderEscalation,
          { orderId: ORDER_ID, disposition: "RETURN_TO_SHIPPING" as const },
          { idempotencyKey: "resolve-no-em" }
        )
      )
    ).rejects.toMatchObject({ code: RESOLVE_ESCALATION_NOT_IN_EMERGENCY });
  });

  it("rejects when the target workflow bucket is not provisioned", async () => {
    const fake = buildPrismaFake({ buckets: { SHIPPING: null } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ResolveOrderEscalation,
          { orderId: ORDER_ID, disposition: "RETURN_TO_SHIPPING" as const },
          { idempotencyKey: "resolve-no-target" }
        )
      )
    ).rejects.toMatchObject({ code: RESOLVE_ESCALATION_TARGET_BUCKET_NOT_FOUND });
  });
});

describe("ResolveOrderEscalation — PHI invariant", () => {
  it("redacts reasonText from audit + outbox; surfaces only hasReasonText flag", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ResolveOrderEscalation,
        {
          orderId: ORDER_ID,
          disposition: "RETURN_TO_SHIPPING" as const,
          reasonText: "Re-attempted shipment after carrier exception triage on 2026-05-25.",
        },
        { idempotencyKey: "resolve-phi" }
      )
    );

    const auditCalls = fake.calls.filter((c) => c.table === "auditLog" && c.op === "create");
    const auditMetadata = (auditCalls[0]!.args as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(auditMetadata["hasReasonText"]).toBe(true);
    expect(JSON.stringify(auditMetadata)).not.toContain("triage on 2026-05-25");

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxPayload = (
      outboxCalls[0]!.args as { data: Array<{ payload: Record<string, unknown> }> }
    ).data[0]!.payload;
    expect(outboxPayload["hasReasonText"]).toBe(true);
    expect(JSON.stringify(outboxPayload)).not.toContain("triage on 2026-05-25");
  });
});
