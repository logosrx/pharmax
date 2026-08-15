// RevokeWebhookSubscription contract tests.
//
// Disabling is what stops egress: fan-out consults the subscription
// status at delivery-creation time, so a revocation that returns
// cleanly without persisting leaves a compromised receiver still
// being fed. The assertions read the row back out of the store
// rather than settling for "the handler did not throw".
//
// The org filter this command depends on is injected by the tenancy
// Prisma extension, not written into the handler's own `where`, so
// the fake routes the WebhookSubscription delegate through the REAL
// extension — a fake that skipped it would grade the cross-tenant
// test against a filter production never applied.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope, type PrismaClient } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { applyTenancyExtension, buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  RevokeWebhookSubscription,
  REVOKE_WEBHOOK_SUBSCRIPTION_ALREADY_DISABLED,
  REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND,
} from "./revoke-webhook-subscription.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000ff";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-0000000000e1";
const SUBSCRIPTION_URL = "https://partner.example.com/hooks";
const REASON = "Partner reported their receiver was compromised.";
/**
 * The instant the bus clock is frozen at. `disabledAt` is stamped
 * from the injected clock, so the row, the command output, and the
 * outbox `occurredAt` are all pinned to this exact value.
 */
const FROZEN_NOW = new Date("2026-07-31T12:00:00.000Z");

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.WEBHOOKS_MANAGE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface SubscriptionRow {
  id: string;
  organizationId: string;
  status: string;
  url: string;
  disabledAt: Date | null;
}

type QueryArgs = Record<string, unknown> | undefined;

interface ExtensionCallback {
  model: string | undefined;
  operation: string;
  args: QueryArgs;
  query: (args: QueryArgs) => Promise<unknown>;
}

/**
 * Wrap a set of model operations in the real `pharmax-tenancy`
 * extension, so each call sees the same injected `where` that the
 * production client would hand to Postgres.
 */
function tenancyRouted(
  model: string,
  operations: Record<string, (args: QueryArgs) => Promise<unknown>>
): Record<string, (args: QueryArgs) => Promise<unknown>> {
  let handler: ((cb: ExtensionCallback) => Promise<unknown>) | undefined;
  const capture = {
    $extends(arg: {
      query?: { $allModels?: { $allOperations?: (cb: ExtensionCallback) => Promise<unknown> } };
    }) {
      handler = arg.query?.$allModels?.$allOperations;
      return capture;
    },
  };
  applyTenancyExtension(capture as unknown as PrismaClient);

  const delegate: Record<string, (args: QueryArgs) => Promise<unknown>> = {};
  for (const [operation, run] of Object.entries(operations)) {
    delegate[operation] = async (args) =>
      handler!({ model, operation, args, query: (injected) => run(injected) });
  }
  return delegate;
}

function matchesWhere(row: SubscriptionRow, where: QueryArgs): boolean {
  if (where === undefined) return false;
  return Object.entries(where).every(([key, value]) => row[key as keyof SubscriptionRow] === value);
}

function buildPrismaFake(rows: ReadonlyArray<SubscriptionRow>) {
  const calls: FakeCall[] = [];
  const store = new Map(rows.map((row) => [row.id, { ...row }]));

  const findUnique = vi.fn(async (args: QueryArgs) => {
    calls.push({ table: "webhookSubscription", op: "findUnique", args });
    for (const row of store.values()) {
      if (matchesWhere(row, args?.["where"] as QueryArgs)) return { ...row };
    }
    return null;
  });

  const update = vi.fn(async (args: QueryArgs) => {
    calls.push({ table: "webhookSubscription", op: "update", args });
    for (const row of store.values()) {
      if (matchesWhere(row, args?.["where"] as QueryArgs)) {
        Object.assign(row, args?.["data"] as Partial<SubscriptionRow>);
        return { id: row.id };
      }
    }
    throw new Error("update matched no row");
  });

  const tx = {
    webhookSubscription: tenancyRouted("WebhookSubscription", { findUnique, update }),
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
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
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
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

  return { client, calls, store, findUnique, update };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(FROZEN_NOW),
    logger: logger.noopLogger,
  });
}

function activeSubscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: SUBSCRIPTION_ID,
    organizationId: ORG_ID,
    status: "ACTIVE",
    url: SUBSCRIPTION_URL,
    disabledAt: null,
    ...overrides,
  };
}

function revoke(idempotencyKey: string) {
  return withTenancyContext(ctx(), () =>
    executeCommand(
      RevokeWebhookSubscription,
      { subscriptionId: SUBSCRIPTION_ID, reason: REASON },
      { idempotencyKey }
    )
  );
}

async function revokeRejection(idempotencyKey: string): Promise<Record<string, unknown>> {
  try {
    await revoke(idempotencyKey);
  } catch (caught: unknown) {
    return caught as Record<string, unknown>;
  }
  throw new Error("expected the revocation to be refused");
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_USER_ID, grants },
    ]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("RevokeWebhookSubscription — happy path", () => {
  it("persists the DISABLED status that stops egress", async () => {
    const fake = buildPrismaFake([activeSubscription()]);
    configureBus(fake.client);

    const out = await revoke("rws-1");

    // Fan-out reads this column to decide whether to keep
    // delivering; if the write is lost the endpoint stays live.
    const row = fake.store.get(SUBSCRIPTION_ID)!;
    expect(row.status).toBe("DISABLED");
    expect(row.disabledAt).toEqual(FROZEN_NOW);

    expect(out.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(out.url).toBe(SUBSCRIPTION_URL);
    expect(out.disabledAt).toBe(FROZEN_NOW.toISOString());
  });

  it("records who cut the endpoint off and why", async () => {
    const fake = buildPrismaFake([activeSubscription()]);
    configureBus(fake.client);

    await revoke("rws-2");

    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const auditData = (
      audit!.args as { data: { action: string; metadata: Record<string, unknown> } }
    ).data;
    expect(auditData.action).toBe("platform.webhook_subscription.revoked");
    expect(auditData.metadata["reason"]).toBe(REASON);
    expect(auditData.metadata["url"]).toBe(SUBSCRIPTION_URL);

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["eventType"]).toBe("platform.webhook_subscription.revoked.v1");
    const payload = rows[0]!["payload"] as Record<string, unknown>;
    expect(payload["revokedByUserId"]).toBe(ACTOR_USER_ID);
    expect(payload["organizationId"]).toBe(ORG_ID);
    // Same instant as the row, from the same injected clock — a
    // subscriber reconciling against `disabledAt` must not see skew.
    expect(payload["occurredAt"]).toBe(FROZEN_NOW.toISOString());
  });
});

describe("RevokeWebhookSubscription — cross-tenant", () => {
  it("refuses a subscription belonging to another organization and leaves it live", async () => {
    // If this regresses, one tenant can silence another tenant's
    // event delivery.
    const fake = buildPrismaFake([activeSubscription({ organizationId: OTHER_ORG_ID })]);
    configureBus(fake.client);

    await expect(revoke("rws-3")).rejects.toMatchObject({
      code: REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND,
    });

    expect(fake.store.get(SUBSCRIPTION_ID)!.status).toBe("ACTIVE");
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("refuses it identically to an id that does not exist at all", async () => {
    // Any difference between the two refusals turns this endpoint
    // into an oracle for enumerating other tenants' subscriptions.
    const foreignFake = buildPrismaFake([activeSubscription({ organizationId: OTHER_ORG_ID })]);
    configureBus(foreignFake.client);
    const foreign = await revokeRejection("rws-4");

    resetCommandBusConfigurationForTests();
    const absentFake = buildPrismaFake([]);
    configureBus(absentFake.client);
    const absent = await revokeRejection("rws-5");

    expect(foreign["name"]).toBe(absent["name"]);
    expect(foreign["code"]).toBe(absent["code"]);
    expect(foreign["message"]).toBe(absent["message"]);
    expect(foreign["metadata"]).toEqual(absent["metadata"]);
  });

  it("never leaks the foreign endpoint's url in the refusal", async () => {
    // The url is partner infrastructure metadata; echoing it back
    // would confirm the id exists in some other tenant.
    const fake = buildPrismaFake([activeSubscription({ organizationId: OTHER_ORG_ID })]);
    configureBus(fake.client);

    const rejection = await revokeRejection("rws-6");

    expect(JSON.stringify(rejection)).not.toContain(SUBSCRIPTION_URL);
  });
});

describe("RevokeWebhookSubscription — guards", () => {
  it("refuses an already-disabled subscription rather than re-disabling it", async () => {
    const disabledAt = new Date("2026-07-01T00:00:00.000Z");
    const fake = buildPrismaFake([activeSubscription({ status: "DISABLED", disabledAt })]);
    configureBus(fake.client);

    await expect(revoke("rws-7")).rejects.toMatchObject({
      code: REVOKE_WEBHOOK_SUBSCRIPTION_ALREADY_DISABLED,
    });

    // The original cut-off timestamp survives a second attempt.
    expect(fake.store.get(SUBSCRIPTION_ID)!.disabledAt).toEqual(disabledAt);
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown subscription id", async () => {
    const fake = buildPrismaFake([]);
    configureBus(fake.client);

    await expect(revoke("rws-8")).rejects.toMatchObject({
      code: REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND,
    });
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("requires a reason at the schema boundary", async () => {
    const fake = buildPrismaFake([activeSubscription()]);
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RevokeWebhookSubscription,
          { subscriptionId: SUBSCRIPTION_ID, reason: "   " },
          { idempotencyKey: "rws-9" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(fake.findUnique).not.toHaveBeenCalled();
  });

  it("denies a caller without webhooks.manage", async () => {
    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.ORDERS_READ]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake([activeSubscription()]);
    configureBus(fake.client);

    await expect(revoke("rws-10")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.store.get(SUBSCRIPTION_ID)!.status).toBe("ACTIVE");
  });
});
