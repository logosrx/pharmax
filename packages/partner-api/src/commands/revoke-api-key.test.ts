// RevokeApiKey contract tests.
//
// A revocation that returns cleanly but does not persist leaves a
// live credential the operator believes is dead, so the assertions
// below read the row back out of the store rather than settling for
// "the handler did not throw".
//
// The org filter this command depends on is injected by the tenancy
// Prisma extension, not written into the handler's own `where`
// (see the comment on the findUnique call). The fake therefore
// routes the ApiKey delegate through the REAL extension — a fake
// that skipped it would grade the cross-tenant test against a
// filter production never applied.

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
  RevokeApiKey,
  REVOKE_API_KEY_ALREADY_REVOKED,
  REVOKE_API_KEY_NOT_FOUND,
} from "./revoke-api-key.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000ff";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000a1";
const REASON = "Rotated after a laptop was lost.";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.API_KEYS_MANAGE]),
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

interface ApiKeyRow {
  id: string;
  organizationId: string;
  status: string;
  tokenPrefix: string;
  revokedAt: Date | null;
  revokedReason: string | null;
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

function matchesWhere(row: ApiKeyRow, where: QueryArgs): boolean {
  if (where === undefined) return false;
  return Object.entries(where).every(([key, value]) => row[key as keyof ApiKeyRow] === value);
}

function buildPrismaFake(rows: ReadonlyArray<ApiKeyRow>) {
  const calls: FakeCall[] = [];
  const store = new Map(rows.map((row) => [row.id, { ...row }]));

  const findUnique = vi.fn(async (args: QueryArgs) => {
    calls.push({ table: "apiKey", op: "findUnique", args });
    for (const row of store.values()) {
      if (matchesWhere(row, args?.["where"] as QueryArgs)) return { ...row };
    }
    return null;
  });

  const update = vi.fn(async (args: QueryArgs) => {
    calls.push({ table: "apiKey", op: "update", args });
    for (const row of store.values()) {
      if (matchesWhere(row, args?.["where"] as QueryArgs)) {
        Object.assign(row, args?.["data"] as Partial<ApiKeyRow>);
        return { id: row.id };
      }
    }
    throw new Error("update matched no row");
  });

  const tx = {
    apiKey: tenancyRouted("ApiKey", { findUnique, update }),
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
    clock: clock.createFrozenClock(new Date("2026-07-31T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

function activeKey(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: API_KEY_ID,
    organizationId: ORG_ID,
    status: "ACTIVE",
    tokenPrefix: "pxk_tttt",
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function revoke(idempotencyKey: string) {
  return withTenancyContext(ctx(), () =>
    executeCommand(RevokeApiKey, { apiKeyId: API_KEY_ID, reason: REASON }, { idempotencyKey })
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

describe("RevokeApiKey — happy path", () => {
  it("persists the revocation and reports the cut-off", async () => {
    const fake = buildPrismaFake([activeKey()]);
    configureBus(fake.client);

    const out = await revoke("rak-1");

    // The row itself must carry the terminal state — a caller that
    // trusts the return value alone would keep honoring a live key.
    const row = fake.store.get(API_KEY_ID)!;
    expect(row.status).toBe("REVOKED");
    expect(row.revokedReason).toBe(REASON);
    expect(row.revokedAt).toBeInstanceOf(Date);

    expect(out.apiKeyId).toBe(API_KEY_ID);
    expect(out.tokenPrefix).toBe("pxk_tttt");
    expect(out.revokedAt).toBe(row.revokedAt!.toISOString());
  });

  it("records who cut the key off, when, and why", async () => {
    const fake = buildPrismaFake([activeKey()]);
    configureBus(fake.client);

    await revoke("rak-2");

    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const auditData = (
      audit!.args as { data: { action: string; metadata: Record<string, unknown> } }
    ).data;
    expect(auditData.action).toBe("platform.api_key.revoked");
    expect(auditData.metadata["reason"]).toBe(REASON);
    expect(auditData.metadata["tokenPrefix"]).toBe("pxk_tttt");

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["eventType"]).toBe("platform.api_key.revoked.v1");
    const payload = rows[0]!["payload"] as Record<string, unknown>;
    expect(payload["revokedByUserId"]).toBe(ACTOR_USER_ID);
    expect(payload["organizationId"]).toBe(ORG_ID);
  });
});

describe("RevokeApiKey — cross-tenant", () => {
  it("refuses a key belonging to another organization and leaves it untouched", async () => {
    // If this regresses, one tenant can cut off another tenant's
    // live integration credential.
    const fake = buildPrismaFake([activeKey({ organizationId: OTHER_ORG_ID })]);
    configureBus(fake.client);

    await expect(revoke("rak-3")).rejects.toMatchObject({ code: REVOKE_API_KEY_NOT_FOUND });

    expect(fake.store.get(API_KEY_ID)!.status).toBe("ACTIVE");
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("refuses it identically to an id that does not exist at all", async () => {
    // Any difference between the two refusals turns this endpoint
    // into an oracle for enumerating other tenants' key ids.
    const foreignFake = buildPrismaFake([activeKey({ organizationId: OTHER_ORG_ID })]);
    configureBus(foreignFake.client);
    const foreign = await revokeRejection("rak-4");

    resetCommandBusConfigurationForTests();
    const absentFake = buildPrismaFake([]);
    configureBus(absentFake.client);
    const absent = await revokeRejection("rak-5");

    expect(foreign["name"]).toBe(absent["name"]);
    expect(foreign["code"]).toBe(absent["code"]);
    expect(foreign["message"]).toBe(absent["message"]);
    expect(foreign["metadata"]).toEqual(absent["metadata"]);
  });
});

describe("RevokeApiKey — guards", () => {
  it("refuses an already-revoked key rather than re-revoking it", async () => {
    const fake = buildPrismaFake([
      activeKey({
        status: "REVOKED",
        revokedAt: new Date("2026-07-01T00:00:00.000Z"),
        revokedReason: "Earlier incident.",
      }),
    ]);
    configureBus(fake.client);

    await expect(revoke("rak-6")).rejects.toMatchObject({
      code: REVOKE_API_KEY_ALREADY_REVOKED,
    });

    // The original revocation stamp survives — a second call must
    // not overwrite the reason the key was first cut off.
    const row = fake.store.get(API_KEY_ID)!;
    expect(row.revokedReason).toBe("Earlier incident.");
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown key id", async () => {
    const fake = buildPrismaFake([]);
    configureBus(fake.client);

    await expect(revoke("rak-7")).rejects.toMatchObject({ code: REVOKE_API_KEY_NOT_FOUND });
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("requires a reason at the schema boundary", async () => {
    // The reason is the only record of WHY a credential was cut
    // off; an empty one makes the audit row useless.
    const fake = buildPrismaFake([activeKey()]);
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RevokeApiKey,
          { apiKeyId: API_KEY_ID, reason: "   " },
          { idempotencyKey: "rak-8" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(fake.findUnique).not.toHaveBeenCalled();
  });

  it("denies a caller without api.keys.manage", async () => {
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
    const fake = buildPrismaFake([activeKey()]);
    configureBus(fake.client);

    await expect(revoke("rak-9")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.store.get(API_KEY_ID)!.status).toBe("ACTIVE");
  });
});
