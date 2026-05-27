// RejectFinalVerification contract tests.
//
// Headline assertions in this suite:
//
//   1. The handler writes a `verification_record` row with
//      `decision: REJECTED`, `stage: FINAL`, and a non-null
//      `rejectionReasonCode` from the FILL-error vocabulary. This
//      is the FIRST writer of FINAL-stage REJECTED records — the
//      sibling commands ApproveFinalVerification (APPROVED rows)
//      and RejectPV1/ApprovePV1 (PV1 rows) shipped previously,
//      so this test pins the only remaining `(stage, decision)`
//      shape: `(FINAL, REJECTED)`.
//
//   2. The reason code is validated against the frozen
//      `FINAL_REJECTION_REASONS` list at the Zod boundary. Unknown
//      codes — and codes from the WRONG registry, like
//      `DOSE_INCORRECT` (a PV1-stage code, semantically wrong at
//      FINAL because typing already passed) — surface as
//      `COMMAND_INPUT_INVALID` BEFORE any DB write. The cross-
//      registry guard is a dedicated test because it's a real
//      operator mistake risk: the two registries look alike, and
//      a typo in the API layer that sends a PV1 code to FINAL
//      would otherwise commit a meaningless rejection.
//
//   3. **SoD asymmetry**: rejection BY THE SAME ACTOR who
//      PV1-approved or completed the fill is ALLOWED. Same
//      load-bearing design point as `RejectPV1` — the SoD rules
//      `sod.pv1-final-same-actor` and `sod.fill-final-same-actor`
//      are scoped to `attempted: FINAL_APPROVE`, not
//      `FINAL_REJECT`, because self-rejection is healthy self-
//      correction. The handler MUST NOT declare `sodRules`, so
//      the bus MUST NOT load `order_event` history. Pinning that
//      absence prevents a future maintainer from "symmetrically"
//      adding SoD here.
//
//   4. The destination bucket is resolved from
//      `BUCKET_CODE_FOR_EXCEPTION_STATE` (not
//      `BUCKET_CODE_FOR_STATUS`). The lookup code is "FILL" —
//      the rework loop bounces back to the FILL queue, NOT to
//      typing or PV1 (those already passed; only the physical
//      fill failed). A missing FILL bucket surfaces as the
//      REUSED `FILL_BUCKET_NOT_CONFIGURED` code from
//      `approve-pv1.ts`.
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
import { OrderStageIntervalKind, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type PermissionCode,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { RejectFinalVerification } from "./reject-final-verification.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const PHARMACIST_ID = "00000000-0000-4000-8000-0000000000bb";
const FILL_BUCKET_ID = "00000000-0000-4000-8000-0000000000cc";
const VERIFICATION_RECORD_ID = "00000000-0000-4000-8000-0000000000ff";

const orgWideFinalRejectGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FINAL_REJECT]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: PHARMACIST_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({ orderId: ORDER_ID, reasonCode: "WRONG_DRUG_PULLED" }) as const;

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
   * Default: `{ currentStatus: "FINAL_VERIFICATION_IN_PROGRESS", version: 7 }`
   * — the canonical pre-RejectFinalVerification state (the
   * pharmacist has started final review at seq 7 and is now
   * rejecting).
   */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  policy?: { code: string; version: number; status: string } | null;
  fillBucketFound?: boolean;
  orderUpdateManyCount?: number;
  orderEventHead?: { sequenceNumber: number } | null;
  verificationRecordCreate?: { id: string };
  /**
   * Kind of the currently-open `OrderStageInterval` row at lock time.
   * RejectFinalVerification closes `FINAL_VERIFICATION_ACTIVE` and opens
   * `WAIT_AFTER_FINAL_REJECT` per the SLA transition table, so the
   * default reflects the canonical pre-state.
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
      ? { currentStatus: "FINAL_VERIFICATION_IN_PROGRESS", version: 7 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const fillBucketFound = overrides.fillBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 7 };
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
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      overrides.initialOpenIntervalKind ?? OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE
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
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return fillBucketFound ? { id: FILL_BUCKET_ID } : null;
      }),
    },
    verificationRecord: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "verificationRecord", op: "create", args });
        return verificationRecordCreate;
      }),
    },
    orderEvent: {
      // No sodRules on RejectFinalVerification → findMany MUST
      // NOT be called. Stubbed so a regression that accidentally
      // adds sodRules (and therefore loads history) lights up
      // loudly in test.
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findMany", args });
        return [];
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
    clock: clock.createFrozenClock(new Date("2026-05-23T16:00:00.000Z")),
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
      { organizationId: ORG_ID, userId: PHARMACIST_ID, grants: orgWideFinalRejectGrants },
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

describe("RejectFinalVerification — happy path", () => {
  it("returns expected output and writes verification_record + order.update + factory CAS + order_event + audit + outbox", async () => {
    // Canonical chain: …seq=7 (StartFinalVerification).
    // RejectFinalVerification writes seq 8.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "reject-final-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "FINAL_VERIFICATION_REJECTED",
      version: 8,
      transitionId: "wf.v1.reject_final_verification",
      verificationRecordId: VERIFICATION_RECORD_ID,
      reasonCode: "WRONG_DRUG_PULLED",
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Bucket lookup: FILL bucket sited from target.siteId.
    // FIRST time a FINAL-stage command resolves the FILL bucket
    // for rework (ApprovePV1 resolves it for forward flow,
    // ApproveFinalVerification resolves the SHIPPING bucket).
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "FILL",
    });

    // verification_record write: FINAL + REJECTED + non-null
    // reasonCode (DB CHECK constraint demands non-null for
    // REJECTED rows). `commandLogId` is a runtime-generated ULID
    // from the bus (the factory creates the command_log row
    // BEFORE calling the handler and passes the id down via
    // `commandLogId`). Pin shape, not exact value.
    const vrCalls = callsOf(fake.calls, "verificationRecord", "create");
    expect(vrCalls).toHaveLength(1);
    const vrData = (vrCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(vrData).toEqual({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      stage: "FINAL",
      decision: "REJECTED",
      pharmacistUserId: PHARMACIST_ID,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      rejectionReasonCode: "WRONG_DRUG_PULLED",
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
      currentStatus: "FINAL_VERIFICATION_REJECTED",
      currentBucketId: FILL_BUCKET_ID,
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
      eventType: "order.final.rejected.v1",
      sequenceNumber: 8,
      actorUserId: PHARMACIST_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);

    // SLA: close FINAL_VERIFICATION_ACTIVE + open
    // WAIT_AFTER_FINAL_REJECT. Single-from-state; the static
    // transition table asserts the close kind. The open kind is
    // WAIT_* → no actor on the row.
    const slaCloseCalls = callsOf(fake.calls, "orderStageInterval", "updateMany");
    expect(slaCloseCalls).toHaveLength(1);

    const slaOpenCalls = callsOf(fake.calls, "orderStageInterval", "create");
    expect(slaOpenCalls).toHaveLength(1);
    const slaOpenData = (slaOpenCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(slaOpenData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      kind: OrderStageIntervalKind.WAIT_AFTER_FINAL_REJECT,
      actorUserId: null,
    });
  });

  it("writes verification_record BEFORE order.update (constraint-failure ordering)", async () => {
    // Per the handler comment: the verification_record write
    // happens first so a CHECK-constraint failure surfaces a
    // record-shaped error rather than an "order updated but no
    // record" inconsistency. The atomicity is the same either
    // way (single tx), but the ordering matters for diagnosis.
    // Same invariant as ApprovePV1 / RejectPV1 / ApproveFinalVerification.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), {
        idempotencyKey: "reject-final-order",
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

  it("explicitly clears currentAssigneeUserId to null (symmetric to ApproveFinalVerification)", async () => {
    // The rejecting pharmacist is done; the order belongs back
    // in the FILL queue as unassigned so any tech can pick it
    // up via the standard fill-start flow. The pharmacist's
    // identity is preserved on verification_record + order_event +
    // audit_log.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), {
        idempotencyKey: "reject-final-clear",
      })
    );

    const updateArgs = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateArgs).toHaveProperty("currentAssigneeUserId", null);
  });

  it("emits order.final.rejected.v1 outbox payload with scope + transition + reasonCode + ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), {
        idempotencyKey: "reject-final-payload",
      })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.final.rejected.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      rejectingPharmacistUserId: PHARMACIST_ID,
      bucketId: FILL_BUCKET_ID,
      transitionId: "wf.v1.reject_final_verification",
      fromState: "FINAL_VERIFICATION_IN_PROGRESS",
      toState: "FINAL_VERIFICATION_REJECTED",
      reasonCode: "WRONG_DRUG_PULLED",
      verificationRecordId: VERIFICATION_RECORD_ID,
      occurredAt: "2026-05-23T16:00:00.000Z",
    });
  });

  it("audit metadata records transition + policy + bucket + reasonCode WITHOUT PHI", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), {
        idempotencyKey: "reject-final-audit",
      })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.final.rejected",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "FINAL_VERIFICATION_IN_PROGRESS",
      toState: "FINAL_VERIFICATION_REJECTED",
      transitionId: "wf.v1.reject_final_verification",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: FILL_BUCKET_ID,
      rejectingPharmacistUserId: PHARMACIST_ID,
      reasonCode: "WRONG_DRUG_PULLED",
      verificationRecordId: VERIFICATION_RECORD_ID,
    });
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId|drugName|ndc|sig/i);
  });

  it("accepts every code in FINAL_REJECTION_REASONS without DB error", async () => {
    // Smoke test for the frozen registry — every code listed in
    // `FINAL_REJECTION_REASONS` must round-trip through Zod and
    // land on the verification_record. If a future maintainer
    // adds a code to the registry but forgets to update the Zod
    // schema, this loop surfaces the gap (Zod fails before any
    // DB write). Symmetric to the equivalent PV1 test.
    const { FINAL_REJECTION_REASONS } = await import("../rejection-reasons.js");
    for (const reasonCode of FINAL_REJECTION_REASONS) {
      const fake = buildPrismaFake();
      configureBus(fake.client);
      await withTenancyContext(ctxFor(), () =>
        executeCommand(
          RejectFinalVerification,
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

describe("RejectFinalVerification — SoD asymmetry (self-rejection allowed)", () => {
  it("does NOT load order_event history (no sodRules declared)", async () => {
    // Pin the absence of `orderEvent.findMany`.
    // RejectFinalVerification intentionally has no `sodRules`
    // clause because the SoD registry has no rule with
    // `attempted: FINAL_REJECT`. The factory's
    // `requireNoSoDViolationForOrder` is therefore skipped, and
    // the history load that ApproveFinalVerification performs
    // MUST NOT happen here.
    //
    // If a future maintainer adds `sodRules` to
    // RejectFinalVerification (e.g., for symmetry with
    // ApproveFinalVerification) without first adding a
    // corresponding SoD registry rule, this assertion fires and
    // points them at the design comment.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), {
        idempotencyKey: "reject-final-no-sod",
      })
    );

    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
    // findFirst (the factory's seq-next lookup) IS the only
    // orderEvent read — proves the factory's normal path runs.
    expect(callsOf(fake.calls, "orderEvent", "findFirst")).toHaveLength(1);
  });

  it("allows self-rejection by the actor who PV1-approved and/or completed the fill on the same order", async () => {
    // The healthy self-correction case. The same person
    // PV1-approved and/or completed the fill, noticed their own
    // error mid-final-review (e.g. "oh no, I pulled the wrong
    // strength"), and is now rejecting it back to fill to fix
    // it. SoD MUST NOT block this — forbidding it would push
    // the actor to "approve anyway and ask someone to fix it
    // later", a much worse outcome (the wrong drug ships).
    //
    // No fixture setup needed beyond the defaults — there's no
    // SoD load to manipulate. The assertion is that the happy
    // path completes (no SOD_VIOLATION raised, all writes
    // happen) even though the actor's identity is unrestricted.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RejectFinalVerification, validInput(), {
        idempotencyKey: "reject-final-self",
      })
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

describe("RejectFinalVerification — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          RejectFinalVerification,
          { orderId: "not-a-uuid", reasonCode: "WRONG_DRUG_PULLED" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects unknown reasonCode (not in FINAL_REJECTION_REASONS) before any DB write", async () => {
    // Unknown code MUST fail at Zod, not at the DB CHECK
    // constraint (which would still catch APPROVED+reasonCode
    // but would silently accept any non-null string for REJECTED
    // rows). Mirrors the equivalent PV1 guard.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          RejectFinalVerification,
          { orderId: ORDER_ID, reasonCode: "NOT_A_REAL_CODE" } as never,
          {
            idempotencyKey: "k",
          }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects a PV1-stage reasonCode (cross-registry guard) before any DB write", async () => {
    // The two registries look alike (both are `string[]`-shaped
    // frozen lists), and a PV1-stage code at FINAL stage is
    // semantically wrong even if the string happens to be a
    // valid identifier. `DOSE_INCORRECT` describes a TYPING
    // error — by the time the order reaches FINAL, the typing
    // already passed PV1 review, so describing the FINAL
    // rejection as a typing error is operator-friction-level
    // misleading. Most importantly, it would silently commit
    // a meaningless rejection if the API layer transposed the
    // command name in a request handler. The Zod schema's
    // `z.enum(FINAL_REJECTION_REASONS)` rejects it at the
    // boundary.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          RejectFinalVerification,
          { orderId: ORDER_ID, reasonCode: "DOSE_INCORRECT" } as never,
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects missing reasonCode before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, { orderId: ORDER_ID } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("RejectFinalVerification — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
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
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
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
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("unsupported policy version → FINAL_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in FILL_COMPLETED_READY_FOR_FINAL (final not yet started) → FINAL_INVALID_TRANSITION", async () => {
    // The "no FINAL reject before FINAL start" guard — a
    // pharmacist must have claimed the review via
    // StartFinalVerification before they can reject.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_COMPLETED_READY_FOR_FINAL", version: 6 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already FINAL_VERIFICATION_REJECTED → FINAL_INVALID_TRANSITION (no double-reject)", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FINAL_VERIFICATION_REJECTED", version: 8 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("order already FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP → FINAL_INVALID_TRANSITION (no retract-after-approval)", async () => {
    // Pins that a pharmacist cannot retract an approval by
    // rejecting after-the-fact. The two-pharmacist sign-off is
    // immutable; if a problem is discovered post-approval, the
    // remediation is CancelOrder + recall workflow, NOT a
    // surreptitious rejection that bypasses the audit trail.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP", version: 8 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → FINAL_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 12 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FINAL_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("FILL bucket missing → FILL_BUCKET_NOT_CONFIGURED, no record/order writes", async () => {
    // Bucket lookup happens BEFORE the verification_record
    // write inside exec, so a missing bucket short-circuits ALL
    // domain writes (record, order, CAS). REUSES the
    // FILL_BUCKET_NOT_CONFIGURED code from ApprovePV1 — same
    // operator remediation (seed the FILL bucket for this site).
    const fake = buildPrismaFake({ fillBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH; no order_event/audit/outbox after the verification_record write", async () => {
    // Subtle invariant: the verification_record write DID
    // happen (it's inside the same tx, before the CAS), but
    // when the CAS misses the WHOLE TX rolls back. The fake
    // records the create call, but in production the row never
    // lands. We assert the in-tx ordering: vr.create happened,
    // order.update happened, order.updateMany returned count=0,
    // and the bus raised before audit/outbox/order_event writes.
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
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

describe("RejectFinalVerification — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("missing FINAL_REJECT permission → PERMISSION_DENIED, no lock attempt", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    // Grant only FINAL_APPROVE (not FINAL_REJECT) — pins the
    // per-permission boundary even within the FINAL stage. In
    // production both come together via the `Pharmacist` role;
    // the bus enforces them independently so a hypothetical
    // "approver-only" or "rejector-only" sub-role is expressible.
    configureGrantsFor(PHARMACIST_ID, new Set([PERMISSIONS.FINAL_APPROVE]));

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("missing FINAL_REJECT permission even when PV1_REJECT is granted → PERMISSION_DENIED (PV1 perms don't carry into FINAL stage)", async () => {
    // Cross-stage permission isolation, mirroring the
    // ApproveFinalVerification cross-stage test. A pharmacist
    // authorized for PV1_REJECT is NOT automatically
    // authorized for FINAL_REJECT — the per-stage permissions
    // are independent, so a typist with a cross-trained
    // PV1_REJECT grant doesn't accidentally inherit FINAL
    // rejection authority.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    configureGrantsFor(PHARMACIST_ID, new Set([PERMISSIONS.PV1_REJECT]));

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RejectFinalVerification, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });
});
