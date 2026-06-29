// ApproveFinalVerification contract tests.
//
// This is the most safety-critical suite shipped so far. Three
// "firsts" land here at once:
//
//   1. **First multi-rule SoD command.** The rbac registry has TWO
//      rules whose `attempted` is `FINAL_APPROVE`
//      (`sod.pv1-final-same-actor` AND `sod.fill-final-same-actor`).
//      Both MUST fire when their precondition is met, even though
//      the handler declares only ONE `sodRules` entry — the fan-out
//      lives in the registry. The suite proves both rules are
//      reachable AND pins the deterministic order in which they
//      fire when both preconditions are present (registry
//      declaration order; pv1-final wins).
//
//   2. **First FINAL-stage `verification_record` writer.** Same
//      structural shape as `ApprovePV1` (decision: APPROVED,
//      reasonCode: null), but with `stage: FINAL`. We exercise the
//      same constraint-failure ordering invariant: vr.create BEFORE
//      order.update.
//
//   3. **First SHIPPING-bucket transition.** Destination bucket
//      code is `"SHIPPING"`. A missing bucket surfaces NEW code
//      `SHIPPING_BUCKET_NOT_CONFIGURED` (will be REUSED by future
//      `ReleaseToShip` and `ConfirmShipment`).
//
// All other test categories (Zod, lock, policy, transition, terminal,
// bucket, CAS, tenancy, RBAC) mirror the typing/PV1 stage suites.
//
// PHI invariant: no fixture carries patient names, DOBs, or other
// PHI. We exercise the command with synthetic UUIDs only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope, OrderStageIntervalKind } from "@pharmax/database";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type PermissionCode,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { ApproveFinalVerification } from "./approve-final-verification.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
// The current actor — the pharmacist attempting to APPROVE FINAL.
// In SoD scenarios this same userId is contrasted with prior acts
// by *different* userIds (healthy) or by *the same* userId (violation).
const PHARMACIST_B_ID = "00000000-0000-4000-8000-0000000000bb";
const PHARMACIST_A_ID = "00000000-0000-4000-8000-0000000000aa1";
const TYPIST_ID = "00000000-0000-4000-8000-000000000088";
const FILL_TECH_ID = "00000000-0000-4000-8000-000000000077";
const SHIPPING_BUCKET_ID = "00000000-0000-4000-8000-0000000000dd";
const VERIFICATION_RECORD_ID = "00000000-0000-4000-8000-0000000000ff";

const orgWideFinalApproveGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FINAL_APPROVE]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: PHARMACIST_B_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({ orderId: ORDER_ID });

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeHistoryRow {
  readonly eventType: string;
  readonly actorUserId: string | null;
  readonly sequenceNumber: number;
}

interface FakeOverrides {
  /**
   * Row returned by the factory's `SELECT … FOR UPDATE`. NULL means
   * "no row" — surfaces as ORDER_NOT_FOUND.
   * Default: `{ currentStatus: "FINAL_VERIFICATION_IN_PROGRESS", version: 7 }`
   * — the canonical pre-ApproveFinalVerification state (after
   * StartFinalVerification claimed the order at seq 7).
   */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  policy?: { code: string; version: number; status: string } | null;
  shippingBucketFound?: boolean;
  orderUpdateManyCount?: number;
  orderEventHead?: { sequenceNumber: number } | null;
  /**
   * SoD history rows returned by `orderEvent.findMany`. Default is
   * the canonical chain:
   *   seq 1: order.received.v1            — TYPIST_ID
   *   seq 2: order.typing.started.v1      — TYPIST_ID
   *   seq 3: order.typing.completed.v1    — TYPIST_ID
   *   seq 4: order.pv1.started.v1         — PHARMACIST_A_ID
   *   seq 5: order.pv1.approved.v1        — PHARMACIST_A_ID
   *   seq 6: order.fill.completed.v1      — FILL_TECH_ID
   *   seq 7: order.final.started.v1       — PHARMACIST_B_ID (current actor)
   * — a healthy three-actor separation that SHOULD NOT raise SoD.
   * Note: `order.final.started.v1` is by the current actor and that
   * IS fine because no SoD rule has `FINAL_APPROVE` colliding with
   * a prior `FINAL_START` — claiming the review is not the same as
   * having signed any other stage.
   */
  history?: ReadonlyArray<FakeHistoryRow>;
  verificationRecordCreate?: { id: string };
}

const DEFAULT_HEALTHY_HISTORY: ReadonlyArray<FakeHistoryRow> = [
  { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
  { eventType: "order.typing.started.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
  { eventType: "order.typing.completed.v1", actorUserId: TYPIST_ID, sequenceNumber: 3 },
  { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_A_ID, sequenceNumber: 4 },
  { eventType: "order.pv1.approved.v1", actorUserId: PHARMACIST_A_ID, sequenceNumber: 5 },
  { eventType: "order.fill.completed.v1", actorUserId: FILL_TECH_ID, sequenceNumber: 6 },
  { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 7 },
];

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "FINAL_VERIFICATION_IN_PROGRESS", version: 7 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const shippingBucketFound = overrides.shippingBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 7 };
  const history = overrides.history ?? DEFAULT_HEALTHY_HISTORY;
  const verificationRecordCreate = overrides.verificationRecordCreate ?? {
    id: VERIFICATION_RECORD_ID,
  };

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE
    ),
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
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return shippingBucketFound ? { id: SHIPPING_BUCKET_ID } : null;
      }),
    },
    verificationRecord: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "verificationRecord", op: "create", args });
        return verificationRecordCreate;
      }),
    },
    orderEvent: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findMany", args });
        return history;
      }),
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-8" };
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
    clock: clock.createFrozenClock(new Date("2026-05-23T15:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

function configureGrantsFor(userId: string, permissions: Set<PermissionCode>): void {
  resetRbacConfigurationForTests();
  configureRbac({
    loader: new InMemoryPermissionLoader([
      {
        organizationId: ORG_ID,
        userId,
        grants: [
          {
            roleScope: RoleScope.ORGANIZATION,
            grantScope: { siteId: null, clinicId: null, teamId: null },
            permissions,
          },
        ],
      },
    ]),
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: PHARMACIST_B_ID, grants: orgWideFinalApproveGrants },
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

describe("ApproveFinalVerification — happy path", () => {
  it("returns expected output and writes verification_record + order.update + factory CAS + order_event + audit + outbox", async () => {
    // Canonical chain: …seq=7 (StartFinalVerification).
    // ApproveFinalVerification writes seq 8.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "approve-final-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      version: 8,
      transitionId: "wf.v1.approve_final_verification",
      verificationRecordId: VERIFICATION_RECORD_ID,
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Bucket lookup: SHIPPING bucket sited from target.siteId.
    // First time the codebase resolves the SHIPPING bucket from
    // workflow state — this assertion pins the canonical code.
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "SHIPPING",
    });

    // verification_record write: FINAL + APPROVED + null reasonCode.
    // First FINAL-stage record. `commandLogId` is the runtime ULID
    // generated by the factory before the handler runs.
    const vrCalls = callsOf(fake.calls, "verificationRecord", "create");
    expect(vrCalls).toHaveLength(1);
    const vrData = (vrCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(vrData).toEqual({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      stage: "FINAL",
      decision: "APPROVED",
      pharmacistUserId: PHARMACIST_B_ID,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      rejectionReasonCode: null,
      // Bus-generated UUID (command_log.id is @db.Uuid).
      commandLogId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ),
    });

    // Domain write: state + bucket + ASSIGNEE-CLEAR.
    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateArgs = updateCalls[0]!.args as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: ORDER_ID });
    expect(updateArgs.data).toEqual({
      currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      currentBucketId: SHIPPING_BUCKET_ID,
      currentAssigneeUserId: null,
    });
    expect(updateArgs.data["version"]).toBeUndefined();

    // Factory CAS: keyed on (id, organizationId, version=7) → 8.
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 7 });
    expect(casArgs.data).toEqual({ version: 8 });

    // order_event written with seq = head+1 = 8.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.final.approved.v1",
      sequenceNumber: 8,
      actorUserId: PHARMACIST_B_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("explicitly clears currentAssigneeUserId to null (symmetric to ApprovePV1)", async () => {
    // The approving pharmacist is done; the order belongs in the
    // SHIPPING queue as unassigned so any shipping clerk can claim
    // it via `ReleaseToShip`. The pharmacist's identity is
    // preserved on verification_record + order_event + audit_log.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-clear",
      })
    );

    const updateArgs = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateArgs).toHaveProperty("currentAssigneeUserId", null);
  });

  it("emits order.final.approved.v1 outbox payload with scope + transition + ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-payload",
      })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.final.approved.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      approvingPharmacistUserId: PHARMACIST_B_ID,
      bucketId: SHIPPING_BUCKET_ID,
      transitionId: "wf.v1.approve_final_verification",
      fromState: "FINAL_VERIFICATION_IN_PROGRESS",
      toState: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      verificationRecordId: VERIFICATION_RECORD_ID,
      occurredAt: "2026-05-23T15:00:00.000Z",
    });
  });

  it("writes verification_record BEFORE order.update (constraint-failure ordering)", async () => {
    // Symmetric to ApprovePV1 + RejectPV1. The record is created
    // first so a DB CHECK-constraint failure surfaces a
    // record-shaped error rather than an "order updated but no
    // record" inconsistency. Atomicity is the same either way
    // (single tx), but the ordering matters for diagnosis.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-order",
      })
    );

    const opOrder = fake.calls
      .filter(
        (c) =>
          (c.table === "verificationRecord" && c.op === "create") ||
          (c.table === "order" && c.op === "update")
      )
      .map((c) => `${c.table}.${c.op}`);
    expect(opOrder).toEqual(["verificationRecord.create", "order.update"]);
  });

  it("audit metadata records transition + policy + bucket + verificationRecordId WITHOUT PHI", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-audit",
      })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.final.approved",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "FINAL_VERIFICATION_IN_PROGRESS",
      toState: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
      transitionId: "wf.v1.approve_final_verification",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: SHIPPING_BUCKET_ID,
      approvingPharmacistUserId: PHARMACIST_B_ID,
      verificationRecordId: VERIFICATION_RECORD_ID,
    });
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId|drugName|ndc|sig/i);
  });
});

// ---------------------------------------------------------------------------
// Separation of Duties — multi-rule fan-out (the load-bearing new path)
// ---------------------------------------------------------------------------

describe("ApproveFinalVerification — Separation of Duties (multi-rule fan-out)", () => {
  it("loads order_event history via orderEvent.findMany exactly ONCE (single sodRules entry covers both registry rules)", async () => {
    // THE structural assertion of this slice. Both
    // `sod.pv1-final-same-actor` and `sod.fill-final-same-actor`
    // share `attempted: FINAL_APPROVE`. The handler declares ONE
    // `sodRules` entry; the rbac registry walks BOTH rules
    // against the single loaded history. So `findMany` MUST
    // fire exactly once. If it fires twice, someone added a
    // second redundant `sodRules` entry — that doubles the
    // history-load cost with no enforcement gain.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-sod-loadhistory",
      })
    );

    const findManyCalls = callsOf(fake.calls, "orderEvent", "findMany");
    expect(findManyCalls).toHaveLength(1);
    const args = findManyCalls[0]!.args as {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where).toEqual({ orderId: ORDER_ID });
    expect(args.orderBy).toEqual({ sequenceNumber: "asc" });
    expect(args.select).toEqual({
      eventType: true,
      actorUserId: true,
      sequenceNumber: true,
    });
  });

  it("raises SOD_VIOLATION (sod.pv1-final-same-actor) when actor previously performed PV1_APPROVE on the same order", async () => {
    // The first forbidden flow: the pharmacist who approved PV1 is
    // also attempting to approve final verification. This is the
    // exact case `sod.pv1-final-same-actor` exists to prevent —
    // a single pharmacist's "rubber-stamp" is exactly what the
    // two-pharmacist rule forbids.
    const violatingHistory: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.typing.completed.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
      { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 3 },
      // PHARMACIST_B approved PV1 — the colliding act:
      { eventType: "order.pv1.approved.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 4 },
      { eventType: "order.fill.completed.v1", actorUserId: FILL_TECH_ID, sequenceNumber: 5 },
      { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 6 },
    ];
    const fake = buildPrismaFake({
      history: violatingHistory,
      orderEventHead: { sequenceNumber: 6 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), {
          idempotencyKey: "approve-final-sod-pv1",
        })
      ).rejects.toMatchObject({
        code: "SOD_VIOLATION",
        metadata: expect.objectContaining({
          ruleId: "sod.pv1-final-same-actor",
          attemptedPermission: "final.approve",
          collidingPriorAct: "pv1.approve",
          priorActSequence: "4",
          resourceRef: `order:${ORDER_ID}`,
          actorUserId: PHARMACIST_B_ID,
          organizationId: ORG_ID,
        }),
      });
    });

    // Zero domain mutations, zero verification_record (the
    // pharmacist's "approval intent" must not be persisted when
    // the attempt was forbidden), zero bucket lookups (exec never
    // ran).
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "bucket", "findFirst")).toHaveLength(0);
  });

  it("raises SOD_VIOLATION (sod.fill-final-same-actor) when actor previously performed FILL_COMPLETE on the same order", async () => {
    // The second forbidden flow: a pharmacist who personally
    // completed the fill (e.g. a pharmacist working a tech bench)
    // cannot then be the second-pharmacist verifier on the same
    // order. Independent rule, same actor identity check.
    // PV1_APPROVE is by a DIFFERENT actor here, so only the
    // fill-final rule fires.
    const violatingHistory: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.typing.completed.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
      { eventType: "order.pv1.approved.v1", actorUserId: PHARMACIST_A_ID, sequenceNumber: 3 },
      // PHARMACIST_B (current actor) personally completed the fill:
      { eventType: "order.fill.completed.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 4 },
      { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 5 },
    ];
    const fake = buildPrismaFake({
      history: violatingHistory,
      orderEventHead: { sequenceNumber: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), {
          idempotencyKey: "approve-final-sod-fill",
        })
      ).rejects.toMatchObject({
        code: "SOD_VIOLATION",
        metadata: expect.objectContaining({
          ruleId: "sod.fill-final-same-actor",
          attemptedPermission: "final.approve",
          collidingPriorAct: "fill.complete",
          priorActSequence: "4",
        }),
      });
    });

    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("when BOTH PV1_APPROVE and FILL_COMPLETE by same actor exist, fires sod.pv1-final-same-actor first (registry declaration order)", async () => {
    // Pins deterministic rule order. `RULES` declares
    // `sod.pv1-final-same-actor` BEFORE `sod.fill-final-same-actor`,
    // so when both forbidden prior acts exist by the same actor,
    // the pv1-final rule fires first. This guarantees a stable
    // error surface for clients (the surfaced ruleId is what they
    // display + audit). If we ever swap the registry order, this
    // test fails and the surfaced ruleId changes — both must move
    // together.
    const dualViolation: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      // PHARMACIST_B did EVERYTHING — every rule's precondition met:
      { eventType: "order.pv1.approved.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 2 },
      { eventType: "order.fill.completed.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 3 },
      { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 4 },
    ];
    const fake = buildPrismaFake({
      history: dualViolation,
      orderEventHead: { sequenceNumber: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), {
          idempotencyKey: "approve-final-sod-dual",
        })
      ).rejects.toMatchObject({
        code: "SOD_VIOLATION",
        metadata: expect.objectContaining({
          ruleId: "sod.pv1-final-same-actor",
          collidingPriorAct: "pv1.approve",
        }),
      });
    });
  });

  it("does NOT raise when PV1_APPROVE and FILL_COMPLETE were performed by different actors (healthy flow)", async () => {
    // The healthy default — PHARMACIST_A approved PV1, FILL_TECH
    // completed fill, PHARMACIST_B (current actor) is approving
    // final. Three actors, no SoD rule activates.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-sod-different",
      })
    );

    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
  });

  it("does NOT raise when neither PV1_APPROVE nor FILL_COMPLETE exists in history (degenerate / partial-replay shape)", async () => {
    // An order that somehow reached FINAL_VERIFICATION_IN_PROGRESS
    // with no prior approval acts (data migration, replay edge,
    // etc.). The transition itself is gated by the engine; if it
    // DID land here, SoD has nothing to forbid. The handler should
    // proceed normally.
    const sparseHistory: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 2 },
    ];
    const fake = buildPrismaFake({
      history: sparseHistory,
      orderEventHead: { sequenceNumber: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-sod-sparse",
      })
    );

    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
  });

  it("ignores history rows with no actorUserId (system-emitted prior acts)", async () => {
    // A system-emitted `order.pv1.approved.v1` (e.g. backfill,
    // replay) has `actorUserId: null`. SoD is per-actor; the
    // loader skips these. A null-actor approval MUST NOT
    // falsely raise.
    const systemApproval: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      // actorUserId: null — system event, NOT an actor act.
      { eventType: "order.pv1.approved.v1", actorUserId: null, sequenceNumber: 2 },
      { eventType: "order.fill.completed.v1", actorUserId: null, sequenceNumber: 3 },
      { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 4 },
    ];
    const fake = buildPrismaFake({
      history: systemApproval,
      orderEventHead: { sequenceNumber: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-sod-system",
      })
    );

    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
  });

  it("ignores history rows whose eventType is not in the translator (e.g. order.note.added.v1)", async () => {
    // Informational events are silently skipped by the translator.
    // Even by an actor whose involvement would otherwise be
    // suspicious, an unmapped event MUST NOT trigger SoD.
    const includesUnmapped: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.pv1.approved.v1", actorUserId: PHARMACIST_A_ID, sequenceNumber: 2 },
      { eventType: "order.fill.completed.v1", actorUserId: FILL_TECH_ID, sequenceNumber: 3 },
      // Unmapped event by the current actor; loader skips it.
      { eventType: "order.note.added.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 4 },
      { eventType: "order.final.started.v1", actorUserId: PHARMACIST_B_ID, sequenceNumber: 5 },
    ];
    const fake = buildPrismaFake({
      history: includesUnmapped,
      orderEventHead: { sequenceNumber: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveFinalVerification, validInput(), {
        idempotencyKey: "approve-final-sod-unmapped",
      })
    );

    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("ApproveFinalVerification — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("ApproveFinalVerification — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND, SoD never runs", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE, SoD never runs", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("unsupported policy version → FINAL_POLICY_UNSUPPORTED (post-SoD, in handler)", async () => {
    // SoD runs between policy-load and exec, so findMany WILL fire.
    // The handler's policy-version check is what surfaces the
    // FINAL_POLICY_UNSUPPORTED code.
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in FILL_COMPLETED_READY_FOR_FINAL (FINAL not yet started) → FINAL_INVALID_TRANSITION", async () => {
    // The "no FINAL approve before FINAL start" guard. The
    // pharmacist must have claimed the review via
    // StartFinalVerification before approving.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_COMPLETED_READY_FOR_FINAL", version: 6 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP → FINAL_INVALID_TRANSITION (no double-approve)", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP", version: 8 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already in PV1_REJECTED → FINAL_INVALID_TRANSITION (no skip from rejected back into final-approve)", async () => {
    // Pins that exception states can't sneak into FINAL approval.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_REJECTED", version: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → FINAL_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 12 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("SHIPPING bucket missing → SHIPPING_BUCKET_NOT_CONFIGURED, no verification_record / order update", async () => {
    // Bucket lookup happens BEFORE the verification_record write
    // inside exec, so a missing bucket short-circuits ALL domain
    // writes. Same ordering as ApprovePV1's FILL_BUCKET_NOT_CONFIGURED.
    const fake = buildPrismaFake({ shippingBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "SHIPPING_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    // verification_record + order.update DID happen in the fake
    // (both are inside exec), but the CAS returns count=0 and the
    // whole tx rolls back in production. Downstream factory writes
    // (order_event, audit, outbox) never fire.
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("ApproveFinalVerification — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("missing FINAL_APPROVE permission → PERMISSION_DENIED, no lock attempt", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    // Grant only FINAL_START (not FINAL_APPROVE) — pins the
    // per-permission boundary within the FINAL stage. A pharmacist
    // can claim the order for review without being authorized to
    // sign off on it. In production these come together via the
    // `Pharmacist` role; the bus enforces them independently.
    configureGrantsFor(PHARMACIST_B_ID, new Set([PERMISSIONS.FINAL_START]));

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("missing FINAL_APPROVE permission even when PV1_APPROVE is granted → PERMISSION_DENIED (PV1 perms don't carry into FINAL stage)", async () => {
    // Cross-stage permission isolation. A pharmacist authorized
    // for PV1_APPROVE is NOT automatically authorized for
    // FINAL_APPROVE — this is the entire point of granular
    // per-stage permissions (a typist could in theory be granted
    // a single PV1_APPROVE permission for cross-training; that
    // doesn't open the FINAL gate).
    const fake = buildPrismaFake();
    configureBus(fake.client);

    configureGrantsFor(PHARMACIST_B_ID, new Set([PERMISSIONS.PV1_APPROVE]));

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApproveFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });
});
