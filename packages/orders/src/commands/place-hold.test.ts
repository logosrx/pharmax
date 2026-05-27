// PlaceHold contract tests.
//
// Mirrors `cancel-order.test.ts` because PlaceHold is the
// reversible analogue of the same cross-cutting pattern: many
// from-states, one structured-record table, identical PHI invariant
// shape (free-text in, boolean out to audit/outbox).
//
// Test surface:
//   - Happy path from each of the 14 states in HOLD_FROM_STATES.
//   - terminal-state guards (SHIPPED, CANCELLED → ConflictError).
//   - Self-loop guard (ON_HOLD → INVALID_FROM, NOT a unique
//     violation — the engine catches it first).
//   - Reason enum validation + OTHER-requires-reasonText refinement.
//   - PHI invariant: reasonText is censored from audit + outbox.
//   - Partial unique violation surfaces as ORDER_ALREADY_ON_HOLD.
//   - Tenancy + RBAC.
//   - CAS miss → ORDER_VERSION_MISMATCH.
//
// PHI invariant: no fixture contains patient names or DOBs.
// Synthetic free-text only. Free-text IS exercised — including
// its redaction — but never with realistic PHI content.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { HoldReason, OrderStageIntervalKind, Prisma, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  ORDER_ALREADY_ON_HOLD,
  ORDER_HOLD_INVALID_FROM,
  ORDER_HOLD_TERMINAL_STATE,
  ORDER_PLACE_HOLD_POLICY_UNSUPPORTED,
  PlaceHold,
} from "./place-hold.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const HOLD_ID = "00000000-0000-4000-8000-00000000001d";

const orgWidePlaceHoldGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_PLACE_HOLD]),
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
  reason: HoldReason.WAITING_FOR_PROVIDER,
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
  /** Locked-row payload returned by `$queryRaw SELECT … FOR UPDATE`. */
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
   * If set, `orderHold.create` throws this error instead of returning
   * a fake row. Used to simulate the P2002 partial-unique violation.
   */
  holdCreateError?: Error;
  /**
   * Kind of the currently-open `OrderStageInterval` row at lock time.
   * PlaceHold is multi-from-state, so the open kind varies by source.
   * The handler closes whatever's open without a kind assertion, so
   * the default is benign for all tests; per-state tests may override.
   */
  initialOpenIntervalKind?: OrderStageIntervalKind;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "RECEIVED", version: 3 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead = overrides.orderEventHead === undefined ? null : overrides.orderEventHead;

  const tx = {
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policy === null ? null : { id: POLICY_ID, ...policy };
      }),
    },
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      overrides.initialOpenIntervalKind ?? OrderStageIntervalKind.WAIT_BEFORE_TYPING
    ),
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
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderHold", op: "create", args });
        if (overrides.holdCreateError !== undefined) {
          throw overrides.holdCreateError;
        }
        return { id: HOLD_ID };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-hold" };
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
    clock: clock.createFrozenClock(new Date("2026-05-23T19:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWidePlaceHoldGrants },
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

describe("PlaceHold — happy path", () => {
  it("returns expected output and writes lock + hold row + order.update + CAS + order_event + audit + outbox", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 7 },
      orderEventHead: { sequenceNumber: 2 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        PlaceHold,
        { ...validInput(), reason: HoldReason.WAITING_FOR_INSURANCE },
        { idempotencyKey: "hold-1" }
      )
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      holdId: HOLD_ID,
      currentStatus: "ON_HOLD",
      heldFromStatus: "PV1_IN_PROGRESS",
      version: 8,
      transitionId: "wf.v1.place_hold_from_pv1_in_progress",
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Structured domain record written.
    const holdCalls = callsOf(fake.calls, "orderHold", "create");
    expect(holdCalls).toHaveLength(1);
    const holdData = (holdCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(holdData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      reason: "WAITING_FOR_INSURANCE",
      reasonText: null,
      heldByUserId: USER_ID,
      heldFromStatus: "PV1_IN_PROGRESS",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    expect(holdData["heldAt"]).toEqual(new Date("2026-05-23T19:00:00.000Z"));
    const commandLogId = holdData["placeCommandLogId"];
    expect(typeof commandLogId).toBe("string");
    expect(commandLogId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Order flip: status + assignee null. NO bucket change.
    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateData = (updateCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(updateData).toEqual({
      currentStatus: "ON_HOLD",
      currentAssigneeUserId: null,
    });
    expect(updateData["currentBucketId"]).toBeUndefined();
    expect(updateData["version"]).toBeUndefined();

    // Factory CAS: 7 → 8.
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 7 });
    expect(casArgs.data).toEqual({ version: 8 });

    // order_event seq = head + 1.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.held.v1",
      sequenceNumber: 3,
      actorUserId: USER_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);

    // SLA: close whatever's open (no kind assertion — PlaceHold is
    // multi-from-state, so the transition table entry omits `close`)
    // and open HOLD_ACTIVE with the placer as actor.
    const slaCloseCalls = callsOf(fake.calls, "orderStageInterval", "updateMany");
    expect(slaCloseCalls).toHaveLength(1);
    const slaCloseData = (slaCloseCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(slaCloseData["endedAt"]).toEqual(new Date("2026-05-23T19:00:00.000Z"));
    expect(typeof slaCloseData["closeCommandLogId"]).toBe("string");

    const slaOpenCalls = callsOf(fake.calls, "orderStageInterval", "create");
    expect(slaOpenCalls).toHaveLength(1);
    const slaOpenData = (slaOpenCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(slaOpenData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      kind: OrderStageIntervalKind.HOLD_ACTIVE,
      startedAt: new Date("2026-05-23T19:00:00.000Z"),
      actorUserId: USER_ID,
    });
  });

  it.each([
    ["RECEIVED", "wf.v1.place_hold_from_received"],
    ["TYPING_IN_PROGRESS", "wf.v1.place_hold_from_typing_in_progress"],
    ["TYPED_READY_FOR_PV1", "wf.v1.place_hold_from_typed_ready_for_pv1"],
    ["PV1_IN_PROGRESS", "wf.v1.place_hold_from_pv1_in_progress"],
    ["PV1_APPROVED_READY_FOR_FILL", "wf.v1.place_hold_from_pv1_approved_ready_for_fill"],
    ["FILL_IN_PROGRESS", "wf.v1.place_hold_from_fill_in_progress"],
    ["FILL_COMPLETED_READY_FOR_FINAL", "wf.v1.place_hold_from_fill_completed_ready_for_final"],
    ["FINAL_VERIFICATION_IN_PROGRESS", "wf.v1.place_hold_from_final_verification_in_progress"],
    [
      "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      "wf.v1.place_hold_from_final_verification_approved_ready_for_ship",
    ],
    ["READY_TO_SHIP", "wf.v1.place_hold_from_ready_to_ship"],
    ["TYPING_PENDING_MISSING_INFO", "wf.v1.place_hold_from_typing_pending_missing_info"],
    ["PV1_REJECTED", "wf.v1.place_hold_from_pv1_rejected"],
    ["FINAL_VERIFICATION_REJECTED", "wf.v1.place_hold_from_final_verification_rejected"],
  ])(
    "places a hold from %s with transitionId %s and records heldFromStatus correctly",
    async (fromState, expectedTransitionId) => {
      const fake = buildPrismaFake({
        lockedRow: { currentStatus: fromState, version: 4 },
        orderEventHead: { sequenceNumber: 1 },
      });
      configureBus(fake.client);

      const out = await withTenancyContext(ctxFor(), () =>
        executeCommand(PlaceHold, validInput(), { idempotencyKey: `hold-${fromState}` })
      );

      expect(out.transitionId).toBe(expectedTransitionId);
      expect(out.heldFromStatus).toBe(fromState);
      expect(out.version).toBe(5);

      const holdData = (
        callsOf(fake.calls, "orderHold", "create")[0]!.args as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(holdData["heldFromStatus"]).toBe(fromState);
    }
  );

  it("uses the provided reasonText, writes it to the row, and BLOCKS it from audit/outbox", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const REASON_TEXT = "awaiting prior-auth confirmation from payer";

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        PlaceHold,
        {
          ...validInput(),
          reason: HoldReason.WAITING_FOR_INSURANCE,
          reasonText: REASON_TEXT,
        },
        { idempotencyKey: "hold-text-1" }
      )
    );

    // (a) Persisted on the order_hold row.
    const holdData = (
      callsOf(fake.calls, "orderHold", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(holdData["reasonText"]).toBe(REASON_TEXT);

    // (b) NOT in the audit metadata; the boolean replaces it.
    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data;
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toContain(REASON_TEXT);
    const auditMeta = auditData["metadata"] as Record<string, unknown>;
    expect(auditMeta["hasReasonText"]).toBe(true);
    expect(auditMeta["reasonText"]).toBeUndefined();

    // (c) NOT in the outbox payload either.
    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    const outboxJson = JSON.stringify(outboxRows);
    expect(outboxJson).not.toContain(REASON_TEXT);
    const payload = outboxRows[0]?.["payload"] as Record<string, unknown>;
    expect(payload["hasReasonText"]).toBe(true);
    expect(payload["reasonText"]).toBeUndefined();
  });

  it("treats an empty/whitespace-only reasonText as absent (hasReasonText=false)", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        PlaceHold,
        { ...validInput(), reasonText: "   " },
        { idempotencyKey: "hold-empty-text" }
      )
    );

    const holdData = (
      callsOf(fake.calls, "orderHold", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(holdData["reasonText"]).toBeNull();

    const auditMeta = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data["metadata"] as Record<string, unknown>;
    expect(auditMeta["hasReasonText"]).toBe(false);
  });

  it("emits order.held.v1 outbox payload with scope, reason, fromState, and ISO timestamp", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 4 },
      orderEventHead: { sequenceNumber: 1 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        PlaceHold,
        { ...validInput(), reason: HoldReason.COMPLIANCE_REVIEW },
        { idempotencyKey: "hold-outbox-shape" }
      )
    );

    const outboxRow = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(outboxRow).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.held.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(outboxRow?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      holdId: HOLD_ID,
      reason: "COMPLIANCE_REVIEW",
      hasReasonText: false,
      heldByUserId: USER_ID,
      heldFromStatus: "PV1_IN_PROGRESS",
      transitionId: "wf.v1.place_hold_from_pv1_in_progress",
      occurredAt: "2026-05-23T19:00:00.000Z",
    });
  });

  it("audit metadata records transition + policy + actor + reason WITHOUT PHI markers", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        PlaceHold,
        { ...validInput(), reason: HoldReason.WAITING_FOR_PATIENT },
        { idempotencyKey: "hold-audit-shape" }
      )
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.held",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      holdId: HOLD_ID,
      fromState: "RECEIVED",
      toState: "ON_HOLD",
      transitionId: "wf.v1.place_hold_from_received",
      reason: "WAITING_FOR_PATIENT",
      hasReasonText: false,
      heldByUserId: USER_ID,
      heldFromStatus: "RECEIVED",
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

describe("PlaceHold — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          PlaceHold,
          { orderId: "not-a-uuid", reason: HoldReason.WAITING_FOR_PROVIDER },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
  });

  it("rejects unknown reason value", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          PlaceHold,
          { orderId: ORDER_ID, reason: "ASTROLOGY" as never },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
  });

  it("rejects OTHER without reasonText", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          PlaceHold,
          { orderId: ORDER_ID, reason: HoldReason.OTHER },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("rejects OTHER with whitespace-only reasonText", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          PlaceHold,
          { orderId: ORDER_ID, reason: HoldReason.OTHER, reasonText: "   " },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("ACCEPTS OTHER when reasonText is provided", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        PlaceHold,
        {
          orderId: ORDER_ID,
          reason: HoldReason.OTHER,
          reasonText: "operator-supplied free text",
        },
        { idempotencyKey: "k" }
      )
    );

    expect(out.currentStatus).toBe("ON_HOLD");
    const holdData = (
      callsOf(fake.calls, "orderHold", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(holdData["reason"]).toBe("OTHER");
    expect(holdData["reasonText"]).toBe("operator-supplied free text");
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, { ...validInput(), sneakyPHI: "patient SSN" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Workflow + state failures
// ---------------------------------------------------------------------------

describe("PlaceHold — workflow + state failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
  });

  it("unsupported policy version → ORDER_PLACE_HOLD_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_PLACE_HOLD_POLICY_UNSUPPORTED });
    });
  });

  it("order already ON_HOLD → ORDER_HOLD_INVALID_FROM (engine catches, NOT the unique)", async () => {
    const fake = buildPrismaFake({ lockedRow: { currentStatus: "ON_HOLD", version: 5 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_HOLD_INVALID_FROM });
    });
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("order SHIPPED → ORDER_HOLD_TERMINAL_STATE", async () => {
    const fake = buildPrismaFake({ lockedRow: { currentStatus: "SHIPPED", version: 9 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_HOLD_TERMINAL_STATE });
    });
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
  });

  it("order CANCELLED → ORDER_HOLD_TERMINAL_STATE", async () => {
    const fake = buildPrismaFake({ lockedRow: { currentStatus: "CANCELLED", version: 9 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_HOLD_TERMINAL_STATE });
    });
  });

  it("P2002 unique violation on orderHold insert → ORDER_ALREADY_ON_HOLD (no order update, no CAS, no audit)", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`orderId`)",
      { code: "P2002", clientVersion: "5.22.0" }
    );
    const fake = buildPrismaFake({
      orderEventHead: { sequenceNumber: 1 },
      holdCreateError: p2002,
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_ALREADY_ON_HOLD });
    });

    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("factory CAS miss → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    const fake = buildPrismaFake({
      orderUpdateManyCount: 0,
      orderEventHead: { sequenceNumber: 1 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("PlaceHold — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
  });

  it("missing ORDERS_PLACE_HOLD permission → PERMISSION_DENIED, no lock attempt", async () => {
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
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(0);
  });

  it("does NOT accept ORDERS_RELEASE_HOLD as a substitute for ORDERS_PLACE_HOLD", async () => {
    // The two permissions are intentionally distinct so an admin
    // can grant release authority (e.g. supervisor-only) without
    // granting placement authority.
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
              permissions: new Set([PERMISSIONS.ORDERS_RELEASE_HOLD]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PlaceHold, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("PlaceHold — idempotency contract", () => {
  it("first call succeeds and writes exactly one hold row + one audit + one outbox row", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(PlaceHold, validInput(), { idempotencyKey: "hold-idem-shape" })
    );

    expect(callsOf(fake.calls, "orderHold", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });
});
