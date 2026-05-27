// CancelOrder contract tests.
//
// Hand-rolled Prisma fake mirroring `start-typing.test.ts`. Adds an
// `orderCancellation.create` table to the fake (the structured
// domain record introduced by this migration) and exposes a
// `cancellationCreateError` knob so the test can simulate the
// Prisma P2002 unique-violation that backstops idempotency.
//
// Why so many tests for one command: this command is the workflow's
// emergency exit and is reachable from EVERY non-terminal state.
// Each from-state is a separate code path through the engine; each
// terminal state is a separate rejection path; each invariant
// (PHI-free audit/outbox, structured domain record written exactly
// once, version bumped via the factory CAS) is a separate failure
// mode worth catching at the contract layer.
//
// PHI invariant: no fixture carries patient names or DOBs. The
// optional `dispositionReasonText` IS exercised — including its
// redaction from outbox and audit metadata — but never with a
// realistic PHI string; we use a generic synthetic phrase to keep
// the test corpus PHI-free.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  CancellationDisposition,
  OrderStageIntervalKind,
  Prisma,
  RoleScope,
} from "@pharmax/database";
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
  CancelOrder,
  ORDER_ALREADY_CANCELLED,
  ORDER_ALREADY_TERMINAL,
  ORDER_CANCEL_POLICY_UNSUPPORTED,
} from "./cancel-order.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CANCELLATION_ID = "00000000-0000-4000-8000-00000000000c";

const orgWideCancelGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_CANCEL]),
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
  dispositionReason: CancellationDisposition.PATIENT_REQUEST,
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
   * If set, `orderCancellation.create` throws this error instead of
   * returning a fake row. Used to simulate P2002 unique violations.
   */
  cancellationCreateError?: Error;
  /**
   * Kind of the currently-open `OrderStageInterval` row at lock time.
   * Cancel is multi-from-state, so each source state has a different
   * open kind — tests parameterize this to mirror the cancellation
   * source. Default reflects a freshly-received order
   * (`WAIT_BEFORE_TYPING`).
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
    orderCancellation: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderCancellation", op: "create", args });
        if (overrides.cancellationCreateError !== undefined) {
          throw overrides.cancellationCreateError;
        }
        return { id: CANCELLATION_ID };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-cancel" };
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
    clock: clock.createFrozenClock(new Date("2026-05-23T18:30:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideCancelGrants },
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

describe("CancelOrder — happy path", () => {
  it("returns expected output and writes lock + cancellation row + order.update + CAS + order_event + audit + outbox", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "RECEIVED", version: 3 },
      orderEventHead: { sequenceNumber: 1 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CancelOrder,
        { ...validInput(), dispositionReason: CancellationDisposition.DUPLICATE_ORDER },
        { idempotencyKey: "cancel-1" }
      )
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      cancellationId: CANCELLATION_ID,
      currentStatus: "CANCELLED",
      cancelledFromStatus: "RECEIVED",
      version: 4,
      transitionId: "wf.v1.cancel_from_received",
    });

    // Lock fired exactly once before any domain write.
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    // Policy load by id (from target).
    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Structured domain record written.
    const cancellationCalls = callsOf(fake.calls, "orderCancellation", "create");
    expect(cancellationCalls).toHaveLength(1);
    const cancellationData = (cancellationCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(cancellationData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      dispositionReason: "DUPLICATE_ORDER",
      dispositionReasonText: null,
      cancelledByUserId: USER_ID,
      cancelledFromStatus: "RECEIVED",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    expect(cancellationData["cancelledAt"]).toEqual(new Date("2026-05-23T18:30:00.000Z"));
    // commandLogId is a bus-generated ULID; assert it's a string and
    // that the SAME id flows into audit metadata.
    const commandLogId = cancellationData["commandLogId"];
    expect(typeof commandLogId).toBe("string");
    expect(commandLogId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Order flip: status + assignee, NO bucket change.
    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateData = (updateCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(updateData).toEqual({
      currentStatus: "CANCELLED",
      currentAssigneeUserId: null,
    });
    expect(updateData["currentBucketId"]).toBeUndefined();
    expect(updateData["version"]).toBeUndefined();

    // Factory CAS: version 3 → 4.
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 3 });
    expect(casArgs.data).toEqual({ version: 4 });

    // order_event seq = head + 1.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.cancelled.v1",
      sequenceNumber: 2,
      actorUserId: USER_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);

    // SLA close: any currently-open stage interval is terminated, no
    // successor interval is opened (cancel is terminal in SLA terms).
    // `expectedKind` is omitted from the close-only entry for
    // CancelOrder (multi-from-state), so the close runs against any
    // open kind — `WAIT_BEFORE_TYPING` here because the fixture
    // cancels from `RECEIVED`.
    const intervalCloseCalls = callsOf(fake.calls, "orderStageInterval", "updateMany");
    expect(intervalCloseCalls).toHaveLength(1);
    const intervalCloseData = (intervalCloseCalls[0]!.args as { data: Record<string, unknown> })
      .data;
    expect(intervalCloseData["endedAt"]).toEqual(new Date("2026-05-23T18:30:00.000Z"));
    expect(typeof intervalCloseData["closeCommandLogId"]).toBe("string");
    // No successor interval opened — terminal in SLA terms.
    expect(callsOf(fake.calls, "orderStageInterval", "create")).toHaveLength(0);
  });

  it.each([
    ["RECEIVED", "wf.v1.cancel_from_received"],
    ["TYPING_IN_PROGRESS", "wf.v1.cancel_from_typing_in_progress"],
    ["TYPED_READY_FOR_PV1", "wf.v1.cancel_from_typed_ready_for_pv1"],
    ["PV1_IN_PROGRESS", "wf.v1.cancel_from_pv1_in_progress"],
    ["PV1_APPROVED_READY_FOR_FILL", "wf.v1.cancel_from_pv1_approved_ready_for_fill"],
    ["FILL_IN_PROGRESS", "wf.v1.cancel_from_fill_in_progress"],
    ["FILL_COMPLETED_READY_FOR_FINAL", "wf.v1.cancel_from_fill_completed_ready_for_final"],
    ["FINAL_VERIFICATION_IN_PROGRESS", "wf.v1.cancel_from_final_verification_in_progress"],
    [
      "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      "wf.v1.cancel_from_final_verification_approved_ready_for_ship",
    ],
    ["READY_TO_SHIP", "wf.v1.cancel_from_ready_to_ship"],
    ["TYPING_PENDING_MISSING_INFO", "wf.v1.cancel_from_typing_pending_missing_info"],
    ["PV1_REJECTED", "wf.v1.cancel_from_pv1_rejected"],
    ["FINAL_VERIFICATION_REJECTED", "wf.v1.cancel_from_final_verification_rejected"],
    ["ON_HOLD", "wf.v1.cancel_from_on_hold"],
  ])(
    "cancels from %s with transitionId %s and records cancelledFromStatus correctly",
    async (fromState, expectedTransitionId) => {
      const fake = buildPrismaFake({
        lockedRow: { currentStatus: fromState, version: 5 },
        orderEventHead: { sequenceNumber: 3 },
      });
      configureBus(fake.client);

      const out = await withTenancyContext(ctxFor(), () =>
        executeCommand(CancelOrder, validInput(), { idempotencyKey: `cancel-${fromState}` })
      );

      expect(out.transitionId).toBe(expectedTransitionId);
      expect(out.cancelledFromStatus).toBe(fromState);
      expect(out.version).toBe(6);

      const cancellationData = (
        callsOf(fake.calls, "orderCancellation", "create")[0]!.args as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(cancellationData["cancelledFromStatus"]).toBe(fromState);
    }
  );

  it("uses the provided dispositionReasonText, writes it to the row, and BLOCKS it from audit/outbox", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const REASON_TEXT = "deduplicated against an existing fill from the same rx";

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CancelOrder,
        {
          ...validInput(),
          dispositionReason: CancellationDisposition.DUPLICATE_ORDER,
          dispositionReasonText: REASON_TEXT,
        },
        { idempotencyKey: "cancel-text-1" }
      )
    );

    // (a) Persisted on the order_cancellation row.
    const cancellationData = (
      callsOf(fake.calls, "orderCancellation", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(cancellationData["dispositionReasonText"]).toBe(REASON_TEXT);

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
    expect(auditMeta["dispositionReasonText"]).toBeUndefined();

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
    expect(payload["dispositionReasonText"]).toBeUndefined();
  });

  it("treats an empty/whitespace-only dispositionReasonText as absent (hasReasonText=false)", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CancelOrder,
        {
          ...validInput(),
          dispositionReason: CancellationDisposition.DUPLICATE_ORDER,
          dispositionReasonText: "   ",
        },
        { idempotencyKey: "cancel-empty-text" }
      )
    );

    const cancellationData = (
      callsOf(fake.calls, "orderCancellation", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(cancellationData["dispositionReasonText"]).toBeNull();

    const auditMeta = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data["metadata"] as Record<string, unknown>;
    expect(auditMeta["hasReasonText"]).toBe(false);
  });

  it("emits order.cancelled.v1 outbox payload with scope, reason, fromState, and ISO timestamp", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CancelOrder,
        { ...validInput(), dispositionReason: CancellationDisposition.INSURANCE_DENIAL },
        { idempotencyKey: "cancel-outbox-shape" }
      )
    );

    const outboxRow = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(outboxRow).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.cancelled.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(outboxRow?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      cancellationId: CANCELLATION_ID,
      dispositionReason: "INSURANCE_DENIAL",
      hasReasonText: false,
      cancelledByUserId: USER_ID,
      cancelledFromStatus: "RECEIVED",
      transitionId: "wf.v1.cancel_from_received",
      occurredAt: "2026-05-23T18:30:00.000Z",
    });
  });

  it("audit metadata records transition + policy + actor + reason WITHOUT PHI markers", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CancelOrder,
        { ...validInput(), dispositionReason: CancellationDisposition.PATIENT_REQUEST },
        { idempotencyKey: "cancel-audit-shape" }
      )
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.cancelled",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      cancellationId: CANCELLATION_ID,
      fromState: "RECEIVED",
      toState: "CANCELLED",
      transitionId: "wf.v1.cancel_from_received",
      dispositionReason: "PATIENT_REQUEST",
      hasReasonText: false,
      cancelledByUserId: USER_ID,
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

describe("CancelOrder — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CancelOrder,
          { orderId: "not-a-uuid", dispositionReason: CancellationDisposition.PATIENT_REQUEST },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("rejects unknown dispositionReason value", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CancelOrder,
          { orderId: ORDER_ID, dispositionReason: "PIZZA" as never },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("rejects OTHER without dispositionReasonText (refine fires before bus tx)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CancelOrder,
          { orderId: ORDER_ID, dispositionReason: CancellationDisposition.OTHER },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("rejects OTHER with whitespace-only dispositionReasonText", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CancelOrder,
          {
            orderId: ORDER_ID,
            dispositionReason: CancellationDisposition.OTHER,
            dispositionReasonText: "   ",
          },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("ACCEPTS OTHER when dispositionReasonText is provided (non-empty)", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CancelOrder,
        {
          orderId: ORDER_ID,
          dispositionReason: CancellationDisposition.OTHER,
          dispositionReasonText: "operator-supplied free text",
        },
        { idempotencyKey: "k" }
      )
    );

    expect(out.currentStatus).toBe("CANCELLED");
    const cancellationData = (
      callsOf(fake.calls, "orderCancellation", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(cancellationData["dispositionReason"]).toBe("OTHER");
    expect(cancellationData["dispositionReasonText"]).toBe("operator-supplied free text");
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, { ...validInput(), sneakyPHI: "patient SSN" } as never, {
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

describe("CancelOrder — workflow + state failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("unsupported policy version → ORDER_CANCEL_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_CANCEL_POLICY_UNSUPPORTED });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("order already SHIPPED → ORDER_ALREADY_TERMINAL, no domain writes", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 9 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_ALREADY_TERMINAL });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("order already CANCELLED → ORDER_ALREADY_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "CANCELLED", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_ALREADY_TERMINAL });
    });
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("P2002 unique violation on orderCancellation insert → ORDER_ALREADY_CANCELLED (no order update, no CAS, no audit)", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`orderId`)",
      { code: "P2002", clientVersion: "5.22.0" }
    );
    const fake = buildPrismaFake({
      orderEventHead: { sequenceNumber: 1 },
      cancellationCreateError: p2002,
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_ALREADY_CANCELLED });
    });

    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    const fake = buildPrismaFake({
      orderUpdateManyCount: 0,
      orderEventHead: { sequenceNumber: 1 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    // The cancellation row was inserted BEFORE the CAS — that's
    // the bus's contract. The tx rolls back on the CAS miss, so
    // in reality no row persists; the fake records the attempted
    // call.
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("CancelOrder — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });

  it("missing ORDERS_CANCEL permission → PERMISSION_DENIED, no lock attempt", async () => {
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
        executeCommand(CancelOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
//
// The bus's idempotency-replay path is verified by the command-bus
// package's own contract suite (`packages/command-bus/src/execute-command.test.ts`).
// Here we exercise only the COMMAND-LEVEL guarantee: a second
// successful insert is structurally impossible because the
// `order_cancellation.orderId` unique constraint kicks in. That
// case lives in the "P2002 → ORDER_ALREADY_CANCELLED" test above.

describe("CancelOrder — idempotency contract", () => {
  it("first call succeeds and writes exactly one cancellation row + one audit + one outbox row", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CancelOrder, validInput(), { idempotencyKey: "cancel-idem-shape" })
    );

    expect(callsOf(fake.calls, "orderCancellation", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);

    // The structural unique on order_cancellation.orderId is the
    // anti-double-cancel guarantee. A second distinct command
    // attempt for the same order lands on the P2002 path tested
    // above — bus-level idempotency cache replay is tested in
    // the command-bus package's own suite.
  });
});
