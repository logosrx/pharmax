// ReleaseHold contract tests.
//
// The reversible half of the place/release pattern. The
// state-machine question becomes "is there an active hold to
// close?" — modeled in the fake by an `activeHold` knob on the
// orderHold table.
//
// Test surface:
//   - Happy path restoring each of the 14 heldFromStatus values
//     in HOLD_FROM_STATES (parametric).
//   - Pre-engine guard: order not ON_HOLD → ORDER_NOT_ON_HOLD,
//     even with an active hold row present (the guard fires on
//     order.currentStatus, NOT the hold row's existence).
//   - Inconsistent data: ON_HOLD but no active hold row →
//     ORDER_HOLD_RECORD_CORRUPT (InternalError).
//   - Race: active hold closed by concurrent writer (updateMany
//     count=0) → ORDER_NOT_ON_HOLD.
//   - Release-reason enum validation + OTHER-requires-text refine.
//   - Release without reason is ACCEPTED (optional).
//   - PHI invariant: releaseReasonText is censored from audit + outbox.
//   - Tenancy + RBAC.
//   - CAS miss → ORDER_VERSION_MISMATCH.
//
// PHI invariant: synthetic free-text only, no patient identifiers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { HoldReleaseReason, RoleScope } from "@pharmax/database";
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
  ORDER_HOLD_RECORD_CORRUPT,
  ORDER_NOT_ON_HOLD,
  ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED,
  ReleaseHold,
} from "./release-hold.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const PLACER_USER_ID = "00000000-0000-4000-8000-00000000000b";
const HOLD_ID = "00000000-0000-4000-8000-00000000001d";

const orgWideReleaseGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_RELEASE_HOLD]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({
  orderId: ORDER_ID,
});

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  /** Locked-row payload. Default is ON_HOLD with version 5. */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  /** Row returned by `workflowPolicy.findUnique`. */
  policy?: { code: string; version: number; status: string } | null;
  /** Count returned by `order.updateMany` (the factory CAS). Default 1. */
  orderUpdateManyCount?: number;
  /** Head of `order_event` for sequence numbering. */
  orderEventHead?: { sequenceNumber: number } | null;
  /**
   * Row returned by `orderHold.findFirst`. `null` simulates "ON_HOLD
   * but no active hold row" (corrupt state). Default = the active hold
   * fixture below.
   */
  activeHold?: {
    id: string;
    heldFromStatus: string;
    heldByUserId: string;
  } | null;
  /** Count returned by `orderHold.updateMany` (the conditional close). Default 1. */
  holdUpdateCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "ON_HOLD", version: 5 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead = overrides.orderEventHead === undefined ? null : overrides.orderEventHead;
  const activeHold =
    overrides.activeHold === undefined
      ? { id: HOLD_ID, heldFromStatus: "PV1_IN_PROGRESS", heldByUserId: PLACER_USER_ID }
      : overrides.activeHold;
  const holdUpdateCount = overrides.holdUpdateCount ?? 1;

  const tx = {
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policy === null ? null : { id: POLICY_ID, ...policy };
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
    orderHold: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderHold", op: "findFirst", args });
        return activeHold;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderHold", op: "updateMany", args });
        return { count: holdUpdateCount };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-release" };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        return {
          organizationId: ORG_ID,
          latestHash: Buffer.alloc(32),
          latestSeq: 1n,
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
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
    },
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      let op: string;
      if (/\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)) {
        op = "select_for_update_order";
      } else {
        const verbMatch = /\b(select|insert|update|delete)\b/i.exec(joined);
        op = (verbMatch?.[1] ?? "raw").toLowerCase();
      }
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
      if (op === "select_for_update_order") {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                clinicId: CLINIC_ID,
                siteId: SITE_ID,
                currentStatus: lockedRow.currentStatus,
                version: lockedRow.version,
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
              },
            ];
      }
      return [];
    }),
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        const op = /\bset_config\b/i.test(joined)
          ? "set_config"
          : /\bpg_advisory_xact_lock\b/i.test(joined)
            ? "advisory_lock"
            : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
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

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T19:15:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideReleaseGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ReleaseHold — happy path", () => {
  it("returns expected output, closes the hold row, restores order status, CAS-bumps version, emits hold_released", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "ON_HOLD", version: 5 },
      activeHold: { id: HOLD_ID, heldFromStatus: "PV1_IN_PROGRESS", heldByUserId: PLACER_USER_ID },
      orderEventHead: { sequenceNumber: 4 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ReleaseHold,
        { ...validInput(), releaseReason: HoldReleaseReason.INFO_RECEIVED },
        { idempotencyKey: "release-1" }
      )
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      holdId: HOLD_ID,
      currentStatus: "PV1_IN_PROGRESS",
      releasedToStatus: "PV1_IN_PROGRESS",
      version: 6,
      transitionId: "wf.v1.release_hold",
    });

    // Active-hold lookup.
    const lookup = callsOf(fake.calls, "orderHold", "findFirst");
    expect(lookup).toHaveLength(1);
    expect((lookup[0]!.args as { where: unknown }).where).toEqual({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      releasedAt: null,
    });

    // Conditional close keyed on releasedAt: null.
    const closeCalls = callsOf(fake.calls, "orderHold", "updateMany");
    expect(closeCalls).toHaveLength(1);
    const closeArgs = closeCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(closeArgs.where).toEqual({
      id: HOLD_ID,
      organizationId: ORG_ID,
      releasedAt: null,
    });
    expect(closeArgs.data).toMatchObject({
      releasedByUserId: USER_ID,
      releasedToStatus: "PV1_IN_PROGRESS",
      releaseReason: "INFO_RECEIVED",
      releaseReasonText: null,
    });
    expect(closeArgs.data["releasedAt"]).toEqual(new Date("2026-05-23T19:15:00.000Z"));
    const releaseCommandLogId = closeArgs.data["releaseCommandLogId"];
    expect(typeof releaseCommandLogId).toBe("string");

    // Order flip back to heldFromStatus.
    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateData = (updateCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(updateData).toEqual({ currentStatus: "PV1_IN_PROGRESS" });
    expect(updateData["currentBucketId"]).toBeUndefined();
    expect(updateData["currentAssigneeUserId"]).toBeUndefined();
    expect(updateData["version"]).toBeUndefined();

    // CAS 5 → 6.
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 5 });
    expect(casArgs.data).toEqual({ version: 6 });

    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.hold_released.v1",
      sequenceNumber: 5,
      actorUserId: USER_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it.each([
    ["RECEIVED"],
    ["TYPING_IN_PROGRESS"],
    ["TYPED_READY_FOR_PV1"],
    ["PV1_IN_PROGRESS"],
    ["PV1_APPROVED_READY_FOR_FILL"],
    ["FILL_IN_PROGRESS"],
    ["FILL_COMPLETED_READY_FOR_FINAL"],
    ["FINAL_VERIFICATION_IN_PROGRESS"],
    ["FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP"],
    ["READY_TO_SHIP"],
    ["TYPING_PENDING_MISSING_INFO"],
    ["PV1_REJECTED"],
    ["FINAL_VERIFICATION_REJECTED"],
  ])("restores order to heldFromStatus=%s", async (heldFromStatus) => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "ON_HOLD", version: 5 },
      activeHold: { id: HOLD_ID, heldFromStatus, heldByUserId: PLACER_USER_ID },
      orderEventHead: { sequenceNumber: 1 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ReleaseHold, validInput(), { idempotencyKey: `rel-${heldFromStatus}` })
    );

    expect(out.currentStatus).toBe(heldFromStatus);
    expect(out.releasedToStatus).toBe(heldFromStatus);

    const updateData = (
      callsOf(fake.calls, "order", "update")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(updateData["currentStatus"]).toBe(heldFromStatus);

    const closeArgs = callsOf(fake.calls, "orderHold", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(closeArgs.data["releasedToStatus"]).toBe(heldFromStatus);
  });

  it("uses the provided releaseReasonText, writes it to the row, and BLOCKS it from audit/outbox", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const TEXT = "provider responded with corrected sig at 2pm";

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ReleaseHold,
        {
          ...validInput(),
          releaseReason: HoldReleaseReason.INFO_RECEIVED,
          releaseReasonText: TEXT,
        },
        { idempotencyKey: "release-text-1" }
      )
    );

    const closeArgs = callsOf(fake.calls, "orderHold", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(closeArgs.data["releaseReasonText"]).toBe(TEXT);

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data;
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toContain(TEXT);
    const auditMeta = auditData["metadata"] as Record<string, unknown>;
    expect(auditMeta["hasReleaseReasonText"]).toBe(true);
    expect(auditMeta["releaseReasonText"]).toBeUndefined();

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    const outboxJson = JSON.stringify(outboxRows);
    expect(outboxJson).not.toContain(TEXT);
    const payload = outboxRows[0]?.["payload"] as Record<string, unknown>;
    expect(payload["hasReleaseReasonText"]).toBe(true);
    expect(payload["releaseReasonText"]).toBeUndefined();
  });

  it("accepts release without releaseReason (both reason and text are optional)", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ReleaseHold, validInput(), { idempotencyKey: "release-no-reason" })
    );

    expect(out.currentStatus).toBe("PV1_IN_PROGRESS");

    const closeArgs = callsOf(fake.calls, "orderHold", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(closeArgs.data["releaseReason"]).toBeNull();
    expect(closeArgs.data["releaseReasonText"]).toBeNull();

    const auditMeta = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data["metadata"] as Record<string, unknown>;
    expect(auditMeta["releaseReason"]).toBeNull();
    expect(auditMeta["hasReleaseReasonText"]).toBe(false);
  });

  it("emits order.hold_released.v1 with both placer + releaser stamps in the payload", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ReleaseHold,
        { ...validInput(), releaseReason: HoldReleaseReason.RESOLVED },
        { idempotencyKey: "release-outbox-shape" }
      )
    );

    const outboxRow = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(outboxRow).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.hold_released.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(outboxRow?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      holdId: HOLD_ID,
      releaseReason: "RESOLVED",
      hasReleaseReasonText: false,
      heldByUserId: PLACER_USER_ID,
      releasedByUserId: USER_ID,
      releasedToStatus: "PV1_IN_PROGRESS",
      transitionId: "wf.v1.release_hold",
      occurredAt: "2026-05-23T19:15:00.000Z",
    });
  });

  it("audit metadata records BOTH placer and releaser, transition, policy, with no PHI markers", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ReleaseHold,
        { ...validInput(), releaseReason: HoldReleaseReason.ADMIN_OVERRIDE },
        { idempotencyKey: "release-audit-shape" }
      )
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.hold_released",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      holdId: HOLD_ID,
      fromState: "ON_HOLD",
      toState: "PV1_IN_PROGRESS",
      transitionId: "wf.v1.release_hold",
      releaseReason: "ADMIN_OVERRIDE",
      hasReleaseReasonText: false,
      heldByUserId: PLACER_USER_ID,
      releasedByUserId: USER_ID,
      releasedToStatus: "PV1_IN_PROGRESS",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    expect(typeof metadata["commandLogId"]).toBe("string");
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientName/i);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("ReleaseHold — input validation", () => {
  it("rejects non-UUID orderId", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("rejects unknown releaseReason value", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ReleaseHold,
          { orderId: ORDER_ID, releaseReason: "MAGIC" as never },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects OTHER without releaseReasonText", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ReleaseHold,
          { orderId: ORDER_ID, releaseReason: HoldReleaseReason.OTHER },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects OTHER with whitespace-only releaseReasonText", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          ReleaseHold,
          {
            orderId: ORDER_ID,
            releaseReason: HoldReleaseReason.OTHER,
            releaseReasonText: "   ",
          },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("ACCEPTS OTHER when releaseReasonText is provided", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ReleaseHold,
        {
          orderId: ORDER_ID,
          releaseReason: HoldReleaseReason.OTHER,
          releaseReasonText: "supervisor override — see ticket #1234",
        },
        { idempotencyKey: "k" }
      )
    );

    expect(out.currentStatus).toBe("PV1_IN_PROGRESS");
    const closeArgs = callsOf(fake.calls, "orderHold", "updateMany")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(closeArgs.data["releaseReason"]).toBe("OTHER");
    expect(closeArgs.data["releaseReasonText"]).toBe("supervisor override — see ticket #1234");
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, { ...validInput(), sneakyPHI: "patient SSN" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + state failures
// ---------------------------------------------------------------------------

describe("ReleaseHold — workflow + state failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no domain writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderHold", "findFirst")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderHold", "updateMany")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
  });

  it("unsupported policy version → ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED });
    });
  });

  it("order not ON_HOLD → ORDER_NOT_ON_HOLD, no findFirst, no domain writes", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_NOT_ON_HOLD });
    });
    expect(callsOf(fake.calls, "orderHold", "findFirst")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderHold", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("ON_HOLD but no active hold row → ORDER_HOLD_RECORD_CORRUPT (InternalError, no further writes)", async () => {
    const fake = buildPrismaFake({ activeHold: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_HOLD_RECORD_CORRUPT });
    });
    expect(callsOf(fake.calls, "orderHold", "findFirst")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderHold", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("concurrent writer closed the hold (updateMany count=0) → ORDER_NOT_ON_HOLD", async () => {
    const fake = buildPrismaFake({ holdUpdateCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_NOT_ON_HOLD });
    });
    expect(callsOf(fake.calls, "orderHold", "findFirst")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderHold", "updateMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("factory CAS miss → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    const fake = buildPrismaFake({
      orderUpdateManyCount: 0,
      orderEventHead: { sequenceNumber: 1 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "orderHold", "updateMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("ReleaseHold — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("missing ORDERS_RELEASE_HOLD permission → PERMISSION_DENIED", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
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

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });

  it("does NOT accept ORDERS_PLACE_HOLD as a substitute for ORDERS_RELEASE_HOLD", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.ORDERS_PLACE_HOLD]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ReleaseHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("ReleaseHold — idempotency contract", () => {
  it("first call succeeds and writes exactly one updateMany + one audit + one outbox row", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ReleaseHold, validInput(), { idempotencyKey: "release-idem-shape" })
    );

    expect(callsOf(fake.calls, "orderHold", "updateMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });
});
