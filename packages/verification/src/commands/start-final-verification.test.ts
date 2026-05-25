// StartFinalVerification contract tests.
//
// Mirrors the `start-pv1.test.ts` shape — this is the FINAL-stage
// counterpart of StartPV1 and has the same structural footprint:
// in-flight workflow command, locks the order row, loads policy
// from the locked target, claims the order for the verifying
// pharmacist (assignee-SET, mirror of StartPV1's claim), no
// `sodRules` (the two-pharmacist invariant is enforced at SIGN-OFF
// on ApproveFinalVerification, not at OPEN-REVIEW here).
//
// Fakes are hand-rolled per file so the suite is DB-free and the
// fake exposes exactly the tables this command touches. The fake
// records every call so tests can assert (a) what was inserted,
// (b) what was rejected, (c) the canonical step ordering enforced
// by the defineCommand factory.
//
// PHI invariant: no test fixture carries patient names or DOBs.
// Synthetic UUIDs only.

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
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { StartFinalVerification } from "./start-final-verification.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const FINAL_BUCKET_ID = "00000000-0000-4000-8000-0000000000cc";

const orgWideFinalStartGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FINAL_START]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
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

interface FakeOverrides {
  /**
   * Row returned by the factory's `SELECT … FOR UPDATE`. NULL means
   * "no row" — surfaces as ORDER_NOT_FOUND from the factory.
   *
   * Default: `{ currentStatus: "FILL_COMPLETED_READY_FOR_FINAL",
   * version: 6 }` — the canonical pre-StartFinalVerification state
   * (Create=0, StartTyping=1, CompleteTypingReview=2, StartPV1=3,
   * ApprovePV1=4, StartFill=5, CompleteFill=6).
   */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  /** Row returned by `workflowPolicy.findUnique`. NULL → WORKFLOW_POLICY_NOT_FOUND. */
  policy?: { code: string; version: number; status: string } | null;
  /** Row returned by `bucket.findFirst` for FINAL bucket. NULL → FINAL_BUCKET_NOT_CONFIGURED. */
  finalBucketFound?: boolean;
  /** Count returned by `order.updateMany` (the factory CAS). Default 1 (hit). */
  orderUpdateManyCount?: number;
  /**
   * Head of `order_event` for sequence numbering. Default seq=7
   * (CompleteFill is the last event before this command). Pass
   * `orderEventHead: null` to simulate "no prior events".
   */
  orderEventHead?: { sequenceNumber: number } | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "FILL_COMPLETED_READY_FOR_FINAL", version: 6 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const finalBucketFound = overrides.finalBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  // `??` would coerce a deliberate `null` (meaning "no prior events")
  // into the default — use `in` to preserve caller intent.
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 7 };

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION
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
        return finalBucketFound ? { id: FINAL_BUCKET_ID } : null;
      }),
    },
    orderEvent: {
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
    clock: clock.createFrozenClock(new Date("2026-05-23T13:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideFinalStartGrants },
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

describe("StartFinalVerification — happy path", () => {
  it("returns expected output and writes order.update + factory CAS + order_event + audit + outbox", async () => {
    // Canonical chain: Create=seq1, StartTyping=seq2,
    // CompleteTypingReview=seq3, StartPV1=seq4, ApprovePV1=seq5,
    // StartFill=seq6, CompleteFill=seq7, StartFinalVerification=seq8.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "start-final-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "FINAL_VERIFICATION_IN_PROGRESS",
      version: 7,
      transitionId: "wf.v1.start_final_verification",
    });

    // Lock fired exactly once.
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    // Policy load: by id (from the locked target).
    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Bucket lookup uses siteId from the locked target and the
    // canonical FINAL bucket code from the shared status→bucket map.
    // No extra order.findUnique round-trip.
    expect(callsOf(fake.calls, "order", "findUnique")).toHaveLength(0);
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "FINAL",
    });

    // Domain write: state + bucket + ASSIGNEE-SET (the pharmacist
    // claims the order). NOT the version (that's the factory's CAS step).
    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateArgs = updateCalls[0]!.args as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: ORDER_ID });
    expect(updateArgs.data).toEqual({
      currentStatus: "FINAL_VERIFICATION_IN_PROGRESS",
      currentBucketId: FINAL_BUCKET_ID,
      currentAssigneeUserId: USER_ID,
    });
    expect(updateArgs.data["version"]).toBeUndefined();

    // Factory CAS: updateMany filtered on (id, organizationId, version=6).
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 6 });
    expect(casArgs.data).toEqual({ version: 7 });

    // order_event written with seq = head+1 = 8.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.final.started.v1",
      sequenceNumber: 8,
      actorUserId: USER_ID,
    });

    // Audit + outbox + idempotency.
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("explicitly sets currentAssigneeUserId to the pharmacist (the order was unassigned in the FINAL queue)", async () => {
    // The assignee-set invariant pins that StartFinalVerification
    // claims the order for the pharmacist. CompleteFill (when it
    // ships) will have cleared the assignee to NULL when the order
    // entered the FINAL queue; this command takes ownership again.
    // A careless refactor that left the assignee NULL (or set it
    // to the wrong id) would break the "who is currently working
    // this order" signal that the FINAL dashboard relies on, and
    // would also break the SoD assertions on
    // ApproveFinalVerification (which compares the approving
    // pharmacist against prior PV1_APPROVE / FILL_COMPLETE actors).
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFinalVerification, validInput(), {
        idempotencyKey: "start-final-claim",
      })
    );

    const updateArgs = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateArgs).toHaveProperty("currentAssigneeUserId", USER_ID);
  });

  it("seq=1 when the order has no prior events (defensive — should not happen post-CompleteFill)", async () => {
    const fake = buildPrismaFake({ orderEventHead: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "start-final-2" })
    );

    const oeData = (
      callsOf(fake.calls, "orderEvent", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(oeData["sequenceNumber"]).toBe(1);
  });

  it("emits order.final.started.v1 outbox payload with scope + transition + ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "start-final-3" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.final.started.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      pharmacistUserId: USER_ID,
      bucketId: FINAL_BUCKET_ID,
      transitionId: "wf.v1.start_final_verification",
      fromState: "FILL_COMPLETED_READY_FOR_FINAL",
      toState: "FINAL_VERIFICATION_IN_PROGRESS",
      occurredAt: "2026-05-23T13:00:00.000Z",
    });
  });

  it("audit metadata records transition + policy + bucket WITHOUT PHI", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "start-final-4" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.final.started",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "FILL_COMPLETED_READY_FOR_FINAL",
      toState: "FINAL_VERIFICATION_IN_PROGRESS",
      transitionId: "wf.v1.start_final_verification",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: FINAL_BUCKET_ID,
      pharmacistUserId: USER_ID,
    });
    // BigInt-safe stringify covers the chain writer's `seq` column.
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId|drugName|ndc|sig/i);
  });

  it("does NOT trigger an order_event history read (no sodRules declared)", async () => {
    // The SoD registry has rules only for `attempted: FINAL_APPROVE`
    // (sod.pv1-final-same-actor + sod.fill-final-same-actor). There
    // is no rule for `attempted: FINAL_START` — the two-pharmacist
    // invariant fires at SIGN-OFF, not at OPEN-REVIEW. Pin that the
    // bus does NOT load resource history for this command, so we
    // don't pay for an enforcement that doesn't exist.
    //
    // The factory still calls `orderEvent.findFirst` exactly once
    // (ORDER BY desc LIMIT 1) to compute the next sequenceNumber
    // for the event it's about to write. A SoD history load would
    // be a SECOND read, with `orderBy: { sequenceNumber: "asc" }`
    // and a different select shape.
    //
    // Same regression-guard pattern as StartPV1 and RejectPV1.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "start-final-sod" })
    );

    const oeFindCalls = callsOf(fake.calls, "orderEvent", "findFirst");
    expect(oeFindCalls).toHaveLength(1);
    const findArgs = oeFindCalls[0]!.args as { orderBy?: unknown; take?: number };
    expect(findArgs.orderBy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("StartFinalVerification — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("StartFinalVerification — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND (from factory), no order update", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE, no order update", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("unsupported policy version → FINAL_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in FILL_IN_PROGRESS (fill not complete) → FINAL_INVALID_TRANSITION", async () => {
    // The v1 policy has no (FILL_IN_PROGRESS, START_FINAL_VERIFICATION)
    // row — the tech must first call CompleteFill.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_IN_PROGRESS", version: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("order already FINAL_VERIFICATION_IN_PROGRESS → FINAL_INVALID_TRANSITION (no double-start)", async () => {
    // Idempotency: the bus's idempotency table catches retries by
    // key; this engine guard catches retries that bypass the key.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FINAL_VERIFICATION_IN_PROGRESS", version: 7 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order RECEIVED (no work yet) → FINAL_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "RECEIVED", version: 0 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in PV1_REJECTED (rework loop) → FINAL_INVALID_TRANSITION", async () => {
    // The rejection-loop exception states must not jump straight to
    // FINAL — they re-enter at the upstream stage.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_REJECTED", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in PV1_IN_PROGRESS (pharmacist reviewing typing) → FINAL_INVALID_TRANSITION", async () => {
    // Workflow-safety rule "No final verification before fill
    // completion" — explicit coverage from a pre-FILL state. The
    // pharmacist is still in PV1; final must wait for ApprovePV1 +
    // StartFill + CompleteFill to land first.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 3 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in PV1_APPROVED_READY_FOR_FILL (fill not yet started) → FINAL_INVALID_TRANSITION", async () => {
    // Closer to the goal but still pre-FILL — PV1 is signed off,
    // but no tech has claimed the fill yet. The "No final
    // verification before fill completion" rule covers THIS case
    // specifically: even with a successful PV1, the v1 policy
    // forces the order through StartFill → CompleteFill before
    // FINAL can open.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_APPROVED_READY_FOR_FILL", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP → FINAL_INVALID_TRANSITION (no re-start after approval)", async () => {
    // Double-approve guard: a successful ApproveFinalVerification
    // moves the order to APPROVED_READY_FOR_SHIP. A retry of
    // StartFinalVerification on that same order must NOT be able
    // to re-open the review and override the approval — the
    // ReleaseToShip command is the only legal next step. The bus's
    // idempotency-key table catches retries by key; this engine
    // guard catches retries that bypass the key.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP", version: 9 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → FINAL_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 11 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order is CANCELLED (terminal) → FINAL_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "CANCELLED", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("FINAL bucket missing → FINAL_BUCKET_NOT_CONFIGURED, no order update", async () => {
    const fake = buildPrismaFake({ finalBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("StartFinalVerification — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("missing FINAL_START permission → PERMISSION_DENIED, no lock attempt", async () => {
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
              // The SIGN-OFF permission alone is not enough — a
              // pharmacist who only has FINAL_APPROVE must not be
              // able to open the review either. This pins the
              // per-permission boundary inside the FINAL stage.
              // The SoD boundary (PV1-approver / fill-completer
              // cannot APPROVE the final they're reviewing) is
              // exercised on ApproveFinalVerification when it
              // ships.
              permissions: new Set([PERMISSIONS.FINAL_APPROVE]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("FINAL_REJECT alone is also not a substitute for FINAL_START → PERMISSION_DENIED", async () => {
    // Defense-in-depth: a pharmacist who can REJECT (negative
    // sign-off) but not START still cannot open the review. The
    // three FINAL-stage permissions are independent grants by
    // design — the `Pharmacist` role template carries all three
    // in production, but admins can narrow per-user.
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
              permissions: new Set([PERMISSIONS.FINAL_REJECT]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("PV1_APPROVE alone (cross-stage) is not a substitute for FINAL_START → PERMISSION_DENIED", async () => {
    // Cross-stage isolation: a pharmacist who has only the PV1
    // sign-off permission cannot open a FINAL review. This pins
    // that the bus's permission check is per-permission-code,
    // not per-role-template — a "PV1-only pharmacist" role
    // (PV1_APPROVE + PV1_REJECT, no FINAL_*) is expressible and
    // bounded correctly. Important because operators expect to
    // be able to narrow pharmacist permissions by stage during
    // ramp-up or for compliance-driven SoD policies.
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
              permissions: new Set([PERMISSIONS.PV1_APPROVE]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });
});
