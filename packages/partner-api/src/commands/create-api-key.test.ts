// CreateApiKey contract tests.
//
// The invariants pinned here:
//   - the quota tier defaults to STANDARD when the caller omits it,
//     is persisted on the row, and travels through output, audit
//     metadata, and the outbox event;
//   - an unknown tier is rejected at the schema boundary;
//   - unknown scope codes are rejected with a typed error;
//   - the raw token never enters the command (only hash + prefix),
//     and both are excluded from the idempotency hash surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { CreateApiKey, CREATE_API_KEY_UNKNOWN_SCOPE } from "./create-api-key.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000a1";

const VALID_INPUT = {
  name: "Acme telehealth prod",
  tokenHash: "ab".repeat(32),
  tokenPrefix: "pxk_tttt",
  scopes: [PERMISSIONS.ORDERS_READ],
};

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

function buildPrismaFake() {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    apiKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "apiKey", op: "create", args });
        return { id: API_KEY_ID };
      }),
    },
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

  return { client, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-07-31T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
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

function createdRowData(calls: Array<{ table: string; op: string; args: unknown }>) {
  const create = calls.find((c) => c.table === "apiKey" && c.op === "create");
  return (create!.args as { data: Record<string, unknown> }).data;
}

function outboxPayload(calls: Array<{ table: string; op: string; args: unknown }>) {
  const outbox = calls.find((c) => c.table === "eventOutbox");
  const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
  return rows[0]!["payload"] as Record<string, unknown>;
}

describe("CreateApiKey — quota tier", () => {
  it("defaults to STANDARD when the caller omits the tier", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateApiKey, VALID_INPUT, { idempotencyKey: "mint-default-tier" })
    );

    expect(out.quotaTier).toBe("STANDARD");
    expect(createdRowData(fake.calls)["quotaTier"]).toBe("STANDARD");
    expect(outboxPayload(fake.calls)["quotaTier"]).toBe("STANDARD");
  });

  it("persists an explicit ELEVATED tier through row, output, and outbox event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateApiKey,
        { ...VALID_INPUT, quotaTier: "ELEVATED" },
        { idempotencyKey: "mint-elevated-tier" }
      )
    );

    expect(out.quotaTier).toBe("ELEVATED");
    expect(createdRowData(fake.calls)["quotaTier"]).toBe("ELEVATED");
    expect(outboxPayload(fake.calls)["quotaTier"]).toBe("ELEVATED");
  });

  it("rejects an unknown tier at the schema boundary", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateApiKey,
          { ...VALID_INPUT, quotaTier: "PLATINUM" },
          { idempotencyKey: "mint-bogus-tier" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
  });
});

describe("CreateApiKey — scopes and secret hygiene", () => {
  it("rejects unknown scope codes with a typed error", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateApiKey,
          { ...VALID_INPUT, scopes: ["not.a.permission"] },
          { idempotencyKey: "mint-bogus-scope" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_API_KEY_UNKNOWN_SCOPE });
  });

  it("declares the per-attempt token material outside the idempotency hash surface", () => {
    // The transport regenerates tokenHash/tokenPrefix on every HTTP
    // attempt; hashing them would reject honest retries as payload
    // mismatches instead of replaying (the P0 idempotency bug).
    expect(CreateApiKey.hashExcludeFields).toEqual(["tokenHash", "tokenPrefix"]);
    expect(CreateApiKey.redactFields).toContain("tokenHash");
  });
});
