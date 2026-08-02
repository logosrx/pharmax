// GrantClinicCredit contract tests.
//
// Surface:
//   - Happy path: clinic row locked (FOR UPDATE), balance read,
//     GRANT entry written with a `credit-grant:{ulid}` key, one
//     `billing.clinic_credit.recorded.v1` outbox event carrying the
//     post-grant balance.
//   - Backdating: receivedAt in the past lands on occurredAt.
//   - Guards: future receivedAt, missing / cross-org clinic.
//   - PHI: operatorNote never appears in audit metadata (only
//     `hasOperatorNote`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { ClinicCreditEntryKind, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { CLINIC_CREDIT_CLINIC_NOT_FOUND } from "../credit/clinic-credit.js";
import {
  GRANT_CLINIC_CREDIT_RECEIVED_AT_IN_FUTURE,
  GrantClinicCredit,
} from "./grant-clinic-credit.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

/** Matches the frozen bus clock configured in configureBus(). */
const FROZEN_NOW = "2026-06-01T10:00:00.000Z";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_MANAGE_CLINIC_CREDIT]),
  },
];

interface FakeOverrides {
  /** Rows returned by the clinic FOR UPDATE lock. */
  lockedRows?: Array<{ id: string }>;
  grantedCents?: number | null;
  appliedCents?: number | null;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    clinicCreditEntry: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinicCreditEntry", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findUnique: vi.fn(async () => null),
      aggregate: vi.fn(async (args: { where: { kind: string } }) => {
        calls.push({ table: "clinicCreditEntry", op: "aggregate", args });
        const sum =
          args.where.kind === ClinicCreditEntryKind.GRANT
            ? (overrides.grantedCents ?? null)
            : (overrides.appliedCents ?? null);
        return { _sum: { amountCents: sum } };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async () => null),
    },
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
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      calls.push({ table: "$raw", op: "$queryRaw", args });
      return overrides.lockedRows ?? [{ id: CLINIC_ID }];
    }),
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
    clock: clock.createFrozenClock(new Date(FROZEN_NOW)),
    logger: logger.noopLogger,
  });
}

const ctxFor = () =>
  buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });

function findCall(calls: FakeCall[], table: string, op: string): FakeCall | undefined {
  return calls.find((c) => c.table === table && c.op === op);
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

describe("GrantClinicCredit — happy path", () => {
  it("locks the clinic, writes the GRANT entry, and announces the post-grant balance", async () => {
    const fake = buildPrismaFake({ grantedCents: 5_000, appliedCents: 2_000 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        GrantClinicCredit,
        {
          clinicId: CLINIC_ID,
          amountCents: 1_000,
          source: "OVERPAYMENT",
          referenceNumber: "check 1234",
        },
        { idempotencyKey: "credit-grant-1" }
      )
    );

    // Balance before = 5000 − 2000 = 3000; after the 1000 grant = 4000.
    expect(out).toMatchObject({
      clinicId: CLINIC_ID,
      amountCents: 1_000,
      currency: "usd",
      balanceAfterCents: 4_000,
    });

    // The FOR UPDATE lock is taken before the entry is written.
    const lockIndex = fake.calls.findIndex((c) => c.op === "$queryRaw");
    const createIndex = fake.calls.findIndex(
      (c) => c.table === "clinicCreditEntry" && c.op === "create"
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(lockIndex);

    const create = findCall(fake.calls, "clinicCreditEntry", "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["kind"]).toBe("GRANT");
    expect(data["source"]).toBe("OVERPAYMENT");
    expect(data["amountCents"]).toBe(1_000);
    expect(data["currency"]).toBe("usd");
    expect(data["creditEventKey"]).toMatch(/^credit-grant:/);
    expect(data["appliedToInvoiceId"]).toBeNull();
    const metadata = data["metadata"] as Record<string, unknown>;
    expect(metadata["referenceNumber"]).toBe("check 1234");

    const outbox = findCall(fake.calls, "eventOutbox", "createMany");
    const outboxData = (
      outbox!.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }
    ).data;
    expect(outboxData.map((e) => e.eventType)).toEqual(["billing.clinic_credit.recorded.v1"]);
    expect(outboxData[0]!.payload).toMatchObject({
      clinicId: CLINIC_ID,
      kind: "GRANT",
      source: "OVERPAYMENT",
      amountCents: 1_000,
      balanceAfterCents: 4_000,
      appliedToInvoiceId: null,
    });
  });

  it("stamps a backdated receivedAt on occurredAt", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);
    const receivedAt = "2026-05-28T15:00:00.000Z";

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        GrantClinicCredit,
        { clinicId: CLINIC_ID, amountCents: 500, source: "GOODWILL", receivedAt },
        { idempotencyKey: "credit-grant-backdated-1" }
      )
    );

    const create = findCall(fake.calls, "clinicCreditEntry", "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect((data["occurredAt"] as Date).toISOString()).toBe(receivedAt);
  });
});

describe("GrantClinicCredit — guards", () => {
  it("rejects a receivedAt in the future", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          GrantClinicCredit,
          {
            clinicId: CLINIC_ID,
            amountCents: 500,
            source: "OTHER",
            receivedAt: "2026-06-02T10:00:00.000Z",
          },
          { idempotencyKey: "credit-grant-future-1" }
        )
      )
    ).rejects.toMatchObject({ code: GRANT_CLINIC_CREDIT_RECEIVED_AT_IN_FUTURE });

    expect(findCall(fake.calls, "clinicCreditEntry", "create")).toBeUndefined();
  });

  it("rejects a missing / cross-org clinic with no entry written", async () => {
    const fake = buildPrismaFake({ lockedRows: [] });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          GrantClinicCredit,
          { clinicId: CLINIC_ID, amountCents: 500, source: "OVERPAYMENT" },
          { idempotencyKey: "credit-grant-missing-1" }
        )
      )
    ).rejects.toMatchObject({ code: CLINIC_CREDIT_CLINIC_NOT_FOUND });

    expect(findCall(fake.calls, "clinicCreditEntry", "create")).toBeUndefined();
  });
});

describe("GrantClinicCredit — PHI hygiene", () => {
  it("keeps operatorNote out of audit metadata, surfacing only hasOperatorNote", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        GrantClinicCredit,
        {
          clinicId: CLINIC_ID,
          amountCents: 500,
          source: "OVERPAYMENT",
          operatorNote: "clinic overpaid the May statement by $5",
        },
        { idempotencyKey: "credit-grant-note-1" }
      )
    );

    const audit = findCall(fake.calls, "auditLog", "create");
    // Stringify only `metadata` — the full audit row carries a BigInt
    // chain seq that JSON.stringify cannot serialize.
    const metadata = (audit!.args as { data: { metadata: unknown } }).data.metadata;
    const metadataJson = JSON.stringify(metadata);
    expect(metadataJson).not.toContain("overpaid the May statement");
    expect(metadataJson).toContain('"hasOperatorNote":true');
  });
});
