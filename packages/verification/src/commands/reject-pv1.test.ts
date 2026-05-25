// RejectPV1 contract tests.
//
// Headline assertions in this suite:
//
//   1. The handler writes a `verification_record` row with
//      `decision: REJECTED`, `stage: PV1`, and a non-null
//      `rejectionReasonCode` — this is the FIRST production
//      command (along with the ApprovePV1 amendment landing in
//      the same slice) that writes this table, so the column
//      shape is pinned here.
//
//   2. The reason code is validated against the frozen
//      `PV1_REJECTION_REASONS` list at the Zod boundary. Unknown
//      codes surface as `COMMAND_INPUT_INVALID` (the standard
//      validation failure mode) BEFORE any DB write.
//
//   3. **SoD asymmetry**: rejection BY THE SAME ACTOR who typed
//      or started PV1 is ALLOWED. This is the load-bearing design
//      point — the SoD rule `sod.typing-pv1-same-actor` is
//      scoped to `attempted: PV1_APPROVE`, not `PV1_REJECT`,
//      because self-rejection is healthy self-correction. The
//      handler MUST NOT declare `sodRules`, so the bus MUST NOT
//      load `order_event` history. Pinning that absence prevents
//      a future maintainer from "symmetrically" adding SoD here.
//
//   4. The destination bucket is resolved from
//      `BUCKET_CODE_FOR_EXCEPTION_STATE`, not
//      `BUCKET_CODE_FOR_STATUS`. The lookup code is "TYPING"
//      (the rework loop bounces back to the typing queue). A
//      missing TYPING bucket surfaces as the REUSED
//      `TYPING_BUCKET_NOT_CONFIGURED` code.
//
// PHI invariant: every fixture uses synthetic UUIDs and the
// operational reason-code vocabulary. No patient names, no DOBs,
// no drug names — the audit/outbox JSON is scanned for any of
// those substrings as a regression guard.

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
  type PermissionCode,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { RejectPV1 } from "./reject-pv1.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const PHARMACIST_ID = "00000000-0000-4000-8000-000000000099";
const TYPING_BUCKET_ID = "00000000-0000-4000-8000-0000000000bb";
const VERIFICATION_RECORD_ID = "00000000-0000-4000-8000-0000000000ff";

const orgWidePV1RejectGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PV1_REJECT]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: PHARMACIST_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({ orderId: ORDER_ID, reasonCode: "DOSE_INCORRECT" }) as const;

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
   * Row returned by the factory's `SELECT … FOR UPDATE`. NULL
   * means "no row" — surfaces as ORDER_NOT_FOUND from the factory.
   *
   * Default: `{ currentStatus: "PV1_IN_PROGRESS", version: 4 }` —
   * the canonical pre-RejectPV1 state (the PV1 pharmacist has
   * started the review and is now rejecting).
   */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  policy?: { code: string; version: number; status: string } | null;
  typingBucketFound?: boolean;
  orderUpdateManyCount?: number;
  /** Head of `order_event` for sequence numbering (head + 1 is the next seq). */
  orderEventHead?: { sequenceNumber: number } | null;
  verificationRecordCreate?: { id: string };
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "PV1_IN_PROGRESS", version: 4 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const typingBucketFound = overrides.typingBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 4 };
  const verificationRecordCreate = overrides.verificationRecordCreate ?? {
    id: VERIFICATION_RECORD_ID,
  };

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
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return typingBucketFound ? { id: TYPING_BUCKET_ID } : null;
      }),
    },
    verificationRecord: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "verificationRecord", op: "create", args });
        return verificationRecordCreate;
      }),
    },
    orderEvent: {
      // No sodRules on RejectPV1 → findMany MUST NOT be called.
      // Stubbed so a regression that accidentally adds sodRules
      // (and therefore loads history) lights up loudly in test.
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findMany", args });
        return [];
      }),
      // Factory's seq-next path uses findFirst (ORDER BY desc LIMIT 1).
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-5" };
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
    clock: clock.createFrozenClock(new Date("2026-05-23T13:30:00.000Z")),
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
      { organizationId: ORG_ID, userId: PHARMACIST_ID, grants: orgWidePV1RejectGrants },
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

describe("RejectPV1 — happy path", () => {
  it("returns expected output and writes verification_record + order.update + factory CAS + order_event + audit + outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "PV1_REJECTED",
      version: 5,
      transitionId: "wf.v1.reject_pv1",
      verificationRecordId: VERIFICATION_RECORD_ID,
      reasonCode: "DOSE_INCORRECT",
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Bucket lookup: TYPING bucket sited from target.siteId.
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "TYPING",
    });

    // verification_record write: REJECTED + non-null reasonCode.
    // `commandLogId` is a runtime-generated ULID from the bus
    // (the factory creates the command_log row BEFORE calling
    // the handler and passes the id down via `commandLogId`).
    // Pin shape, not exact value.
    const vrCalls = callsOf(fake.calls, "verificationRecord", "create");
    expect(vrCalls).toHaveLength(1);
    const vrData = (vrCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(vrData).toEqual({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      stage: "PV1",
      decision: "REJECTED",
      pharmacistUserId: PHARMACIST_ID,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      rejectionReasonCode: "DOSE_INCORRECT",
      commandLogId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
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
      currentStatus: "PV1_REJECTED",
      currentBucketId: TYPING_BUCKET_ID,
      currentAssigneeUserId: null,
    });
    expect(updateArgs.data["version"]).toBeUndefined();

    // Factory CAS: keyed on (id, organizationId, version=4) → 5.
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 4 });
    expect(casArgs.data).toEqual({ version: 5 });

    // order_event written with seq = head+1 = 5.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.pv1.rejected.v1",
      sequenceNumber: 5,
      actorUserId: PHARMACIST_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("writes verification_record BEFORE order.update (constraint-failure ordering)", async () => {
    // Per the handler comment: the verification_record write
    // happens first so a CHECK-constraint failure surfaces a
    // record-shaped error rather than an "order updated but no
    // record" inconsistency. The atomicity is the same either
    // way (single tx), but the ordering matters for diagnosis.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-order" })
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

  it("explicitly clears currentAssigneeUserId to null (symmetric to ApprovePV1)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-clear" })
    );

    const updateArgs = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateArgs).toHaveProperty("currentAssigneeUserId", null);
  });

  it("emits order.pv1.rejected.v1 outbox payload with scope + transition + reasonCode + ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-payload" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.pv1.rejected.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      rejectingPharmacistUserId: PHARMACIST_ID,
      bucketId: TYPING_BUCKET_ID,
      transitionId: "wf.v1.reject_pv1",
      fromState: "PV1_IN_PROGRESS",
      toState: "PV1_REJECTED",
      reasonCode: "DOSE_INCORRECT",
      verificationRecordId: VERIFICATION_RECORD_ID,
      occurredAt: "2026-05-23T13:30:00.000Z",
    });
  });

  it("audit metadata records transition + policy + bucket + reasonCode WITHOUT PHI", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-audit" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.pv1.rejected",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "PV1_IN_PROGRESS",
      toState: "PV1_REJECTED",
      transitionId: "wf.v1.reject_pv1",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: TYPING_BUCKET_ID,
      rejectingPharmacistUserId: PHARMACIST_ID,
      reasonCode: "DOSE_INCORRECT",
      verificationRecordId: VERIFICATION_RECORD_ID,
    });
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId|drugName|ndc|sig/i);
  });

  it("accepts every code in PV1_REJECTION_REASONS without DB error", async () => {
    // Smoke test for the frozen registry — every code listed in
    // `PV1_REJECTION_REASONS` must round-trip through Zod and
    // land on the verification_record. If a future maintainer
    // adds a code to the registry but forgets to update the Zod
    // schema, this loops surfaces the gap (Zod fails before
    // any DB write).
    const { PV1_REJECTION_REASONS } = await import("../rejection-reasons.js");
    for (const reasonCode of PV1_REJECTION_REASONS) {
      const fake = buildPrismaFake();
      configureBus(fake.client);
      await withTenancyContext(ctxFor(), () =>
        executeCommand(
          RejectPV1,
          { orderId: ORDER_ID, reasonCode },
          { idempotencyKey: `reject-${reasonCode}` }
        )
      );
      const vrData = (
        callsOf(fake.calls, "verificationRecord", "create")[0]!.args as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(vrData["rejectionReasonCode"]).toBe(reasonCode);
      resetCommandBusConfigurationForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// SoD asymmetry — the load-bearing design point
// ---------------------------------------------------------------------------

describe("RejectPV1 — SoD asymmetry (self-rejection allowed)", () => {
  it("does NOT load order_event history (no sodRules declared)", async () => {
    // Pin the absence of `orderEvent.findMany`. RejectPV1
    // intentionally has no `sodRules` clause because the SoD
    // registry has no rule with `attempted: PV1_REJECT`. The
    // factory's `requireNoSoDViolationForOrder` is therefore
    // skipped, and the history load that ApprovePV1 performs
    // MUST NOT happen here.
    //
    // If a future maintainer adds `sodRules` to RejectPV1
    // (e.g., for symmetry with ApprovePV1) without first adding
    // a corresponding SoD registry rule, this assertion fires
    // and points them at the design comment.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-no-sod" })
    );

    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("allows self-rejection by the actor who typed AND started PV1 on the same order", async () => {
    // The healthy self-correction case. The same person typed
    // the prescription, started PV1, noticed their own typo
    // mid-review, and is now rejecting it back to typing to
    // fix it. SoD MUST NOT block this — forbidding it would
    // push the actor to "approve anyway and ask someone to
    // fix it later", a worse outcome.
    //
    // No fixture setup needed beyond the defaults — there's no
    // SoD load to manipulate. The assertion is that the happy
    // path completes (no SOD_VIOLATION raised, all writes
    // happen) even though the actor's identity is unrestricted.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "reject-self" })
    );

    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("RejectPV1 — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          RejectPV1,
          { orderId: "not-a-uuid", reasonCode: "DOSE_INCORRECT" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects unknown reasonCode (not in PV1_REJECTION_REASONS) before any DB write", async () => {
    // The schema-level frozen list. An unknown code MUST fail
    // at Zod, not at the DB CHECK constraint (which would still
    // catch APPROVED+reasonCode but would silently accept any
    // non-null string for REJECTED rows).
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, { orderId: ORDER_ID, reasonCode: "NOT_A_REAL_CODE" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects missing reasonCode before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, { orderId: ORDER_ID } as never, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("RejectPV1 — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("unsupported policy version → PV1_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in TYPED_READY_FOR_PV1 (PV1 not yet started) → PV1_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPED_READY_FOR_PV1", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already PV1_REJECTED → PV1_INVALID_TRANSITION (no double-reject)", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_REJECTED", version: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → PV1_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 7 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("TYPING bucket missing → TYPING_BUCKET_NOT_CONFIGURED, no record/order writes", async () => {
    const fake = buildPrismaFake({ typingBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH; no order_event/audit/outbox after the verification_record write", async () => {
    // Subtle invariant: the verification_record write DID
    // happen (it's inside the same tx, before the CAS), but
    // when the CAS misses the WHOLE TX rolls back. The fake
    // records the create call, but in production the row
    // never lands. We assert the in-tx ordering: vr.create
    // happened, order.update happened, order.updateMany
    // returned count=0, and the bus raised before audit/outbox/
    // order_event writes.
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
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

describe("RejectPV1 — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("missing PV1_REJECT permission → PERMISSION_DENIED, no lock attempt", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    // Grant only PV1_APPROVE (not PV1_REJECT) — pins the
    // per-permission boundary even within a single stage. In
    // production both come together via the `Pharmacist` role;
    // the bus enforces them independently.
    configureGrantsFor(PHARMACIST_ID, new Set([PERMISSIONS.PV1_APPROVE]));

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectPV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });
});
