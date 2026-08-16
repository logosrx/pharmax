// Contract tests for SetAiAssistPolicy (typing-assist phase 1).
//
// Invariants under test:
//   1. First revision creates the org's policy row at version 1;
//      audit carries before=null and the full after.
//   2. Second revision CAS-bumps the version and audits before/after
//      (the row an auditor reads when asking "who turned the model
//      on, and when?").
//   3. A concurrent revision (CAS miss) is a typed conflict.
//   4. Confidence outside 0–100 is rejected at the boundary.
//   5. RBAC: inventory.products.manage does NOT grant the org policy
//      surface — enabling the model org-wide is its own permission.
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

import { SetAiAssistPolicy } from "./set-ai-assist-policy.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "77777777-7777-4777-8777-777777777777";

const adminGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.AI_ASSIST_POLICY_MANAGE]),
  },
];

const catalogOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_PRODUCTS_MANAGE]),
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
    typingAssistEnabled: true,
    minConfidencePercent: 95,
    allowControlledSubstanceSuggestions: false,
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
  /** Row returned by aiAssistPolicy.findFirst. Default: none. */
  existingPolicy?: {
    id: string;
    version: number;
    typingAssistEnabled: boolean;
    minConfidencePercent: number;
    allowControlledSubstanceSuggestions: boolean;
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
    aiAssistPolicy: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "aiAssistPolicy", op: "findFirst", args });
        return opts.existingPolicy ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "aiAssistPolicy", op: "create", args });
        return (args as { data: { id: string } }).data;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "aiAssistPolicy", op: "updateMany", args });
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

function wireBusAndRbac(client: unknown, grants: ReadonlyArray<ResolvedGrant> = adminGrants): void {
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

describe("SetAiAssistPolicy — first revision", () => {
  it("creates the org policy at version 1 and audits before=null", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SetAiAssistPolicy, validInput(), { idempotencyKey: "ai-policy-1" })
    );

    expect(out.created).toBe(true);
    expect(out.version).toBe(1);
    expect(out.typingAssistEnabled).toBe(true);

    const created = (
      findOnly(fake.calls, "aiAssistPolicy", "create").args as { data: Record<string, unknown> }
    ).data;
    expect(created).toMatchObject({
      id: out.policyId,
      organizationId: ORG_ID,
      typingAssistEnabled: true,
      minConfidencePercent: 95,
      allowControlledSubstanceSuggestions: false,
    });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("ai.assist_policy.created");
    expect(audit.metadata["before"]).toBeNull();
    expect(audit.metadata["after"]).toMatchObject({
      typingAssistEnabled: true,
      minConfidencePercent: 95,
    });

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany").args as {
      data: Array<Record<string, unknown>>;
    };
    expect(outbox.data[0]).toMatchObject({ eventType: "ai.assist_policy.set.v1" });
  });
});

describe("SetAiAssistPolicy — revision", () => {
  const existing = {
    id: POLICY_ID,
    version: 2,
    typingAssistEnabled: false,
    minConfidencePercent: 90,
    allowControlledSubstanceSuggestions: false,
  };

  it("CAS-bumps the version and audits the enable flip with before/after", async () => {
    const fake = buildFakePrisma({ existingPolicy: existing });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SetAiAssistPolicy, validInput(), { idempotencyKey: "ai-policy-2" })
    );

    expect(out.created).toBe(false);
    expect(out.version).toBe(3);

    const update = findOnly(fake.calls, "aiAssistPolicy", "updateMany").args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id: POLICY_ID, version: 2 });
    expect(update.data).toMatchObject({ typingAssistEnabled: true, version: 3 });

    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("ai.assist_policy.revised");
    expect(audit.metadata["before"]).toMatchObject({ typingAssistEnabled: false });
    expect(audit.metadata["after"]).toMatchObject({ typingAssistEnabled: true });
  });

  it("maps a CAS miss to a typed conflict", async () => {
    const fake = buildFakePrisma({ existingPolicy: existing, updateManyCount: 0 });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetAiAssistPolicy, validInput(), { idempotencyKey: "ai-policy-cas" })
      )
    ).rejects.toMatchObject({ code: "AI_ASSIST_POLICY_CONFLICT" });
  });
});

describe("SetAiAssistPolicy — refusals", () => {
  it("rejects a confidence threshold above 100 at the boundary", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SetAiAssistPolicy,
          { ...validInput(), minConfidencePercent: 101 },
          { idempotencyKey: "ai-policy-range" }
        )
      )
    ).rejects.toMatchObject({ httpStatus: 400 });

    expect(fake.calls.filter((c) => c.table === "aiAssistPolicy")).toHaveLength(0);
  });

  it("denies a user holding only inventory.products.manage", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, catalogOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetAiAssistPolicy, validInput(), { idempotencyKey: "ai-policy-rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(fake.calls.filter((c) => c.table === "aiAssistPolicy")).toHaveLength(0);
  });
});
