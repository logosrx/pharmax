// ApprovePV1 contract tests.
//
// The headline test surface here is the **SoD path** — this is the
// first command in the codebase that declares `sodRules`, so the
// suite must prove that:
//
//   (a) the factory loads `order_event` history via
//       `orderEvent.findMany` BEFORE the handler's exec runs;
//   (b) a colliding prior act by the same actor raises
//       AuthorizationError(SOD_VIOLATION) and writes ZERO domain
//       mutations (no order.update, no orderEvent.create, no
//       auditLog.create, no eventOutbox.createMany);
//   (c) the same colliding prior act by a DIFFERENT actor does
//       NOT raise (different-actor immunity is the entire point);
//   (d) history with no `order.typing.completed.v1` events does
//       NOT raise (no rule activation = no enforcement).
//
// All other test categories (Zod, lock, policy, transition,
// terminal, bucket, CAS, tenancy, RBAC) mirror the typing-stage
// contract suites.
//
// PHI invariant: no test fixture carries patient names or DOBs. We
// exercise the command with synthetic UUIDs only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDrugKnowledgeSource } from "@pharmax/clinical-screening";
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

import {
  configureClinicalScreening,
  resetClinicalScreeningConfigurationForTests,
} from "../screening/configure.js";
import {
  createScreeningStubs,
  type ScreeningStubOptions,
  type ScreeningStubs,
  historyTakenNoKnownAllergies,
} from "../screening/test-support.js";

import { ApprovePV1 } from "./approve-pv1.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const PHARMACIST_ID = "00000000-0000-4000-8000-000000000099";
const TYPIST_ID = "00000000-0000-4000-8000-000000000088";
const FILL_BUCKET_ID = "00000000-0000-4000-8000-0000000000cc";
const VERIFICATION_RECORD_ID = "00000000-0000-4000-8000-0000000000ff";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000d1";
const RX_ID = "00000000-0000-4000-8000-0000000000e1";

/**
 * Every fingerprint a default screen produces here, written out
 * rather than imported.
 *
 * An acknowledgement matches a finding on this string and nothing
 * else, so a silent change to `fingerprintOf` would silently orphan
 * every acknowledgement ever recorded. Spelling them out means that
 * change fails here instead.
 *
 * Note what the two input gaps do NOT contain: the drug code. "This
 * platform cannot screen allergies" is the same fact on every line of
 * every order, so one acknowledgement settles it — unlike the
 * knowledge gap, which is about one unrecognised NDC.
 */
const CANDIDATE_NDC = "00000-0000-01";

/**
 * The two gaps a default-configured deployment reports on EVERY order,
 * both graded MINOR because no pharmacist can close either of them: no
 * licensed knowledge source is wired at all, and the sig carries no
 * structured dose.
 *
 * MINOR means INFORMATIONAL, so none of them gates an approval — see
 * `screeningGapSeverity`. They are still persisted on every screen,
 * which is what these fingerprints are pinned for.
 */
const KNOWLEDGE_GAP_FINGERPRINT = `SCR_KNOWLEDGE_UNAVAILABLE|MINOR/DEFINITE|${CANDIDATE_NDC}|remediation=PLATFORM_CAPABILITY;scope=CANDIDATE_DRUG`;
const DOSE_INPUT_GAP_FINGERPRINT =
  "SCR_DOSE_INPUT_UNAVAILABLE|MINOR/DEFINITE|DOSE_RANGE|remediation=PLATFORM_CAPABILITY";

const DEFAULT_GAP_FINGERPRINTS: ReadonlyArray<string> = [
  KNOWLEDGE_GAP_FINGERPRINT,
  DOSE_INPUT_GAP_FINGERPRINT,
];

/**
 * The per-patient allergy gap, for a patient nobody has asked. MODERATE
 * and therefore acknowledge-tier, which is why the default fixture below
 * gives its patient an asserted-empty history instead: these suites test
 * transitions, not allergy capture.
 *
 * Asserted directly in "refuses to approve for a patient whose allergy
 * history was never taken", which is what documents that the fixture's
 * assertion is load-bearing rather than decorative.
 */
const ALLERGY_NOT_RECORDED_FINGERPRINT =
  "SCR_ALLERGY_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DRUG_ALLERGY|remediation=SUBJECT_DATA";

/**
 * One prescription on the order, nothing else on the profile, and an
 * allergy history that was taken and found nothing.
 *
 * Against the empty knowledge source — the only source this repository
 * ships — that is two findings, both of them gaps, and NEITHER of them
 * outstanding. That is deliberately the default state of these tests: a
 * default-configured deployment can screen almost nothing, says so on
 * every order, and does not make a pharmacist click through a product
 * backlog to sign off. Suites that need an outstanding finding wire a
 * provisioned knowledge source, as the committed-refusal suite below
 * does.
 *
 * The allergy assertion is load-bearing for these tests and worth
 * understanding: WITHOUT it the patient is one nobody has asked, the
 * DRUG_ALLERGY axis resolves NOT_RECORDED_FOR_SUBJECT, and every
 * approval below would refuse on an unacknowledged screening gap
 * instead of testing its own subject. See
 * `allergy-availability.test.ts` for that path asserted directly.
 */
const DEFAULT_SCREENING_STUBS: ScreeningStubOptions = {
  patientId: PATIENT_ID,
  orderLinePrescriptionIds: [RX_ID],
  historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID)],
  prescriptions: [{ id: RX_ID, patientId: PATIENT_ID, drugNdc: CANDIDATE_NDC, status: "ACTIVE" }],
};

const orgWidePV1ApproveGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PV1_APPROVE]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: PHARMACIST_ID, correlationId: "01CORRELATION0000000000000" },
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

/**
 * Synthetic order_event history row. The fake's `orderEvent.findMany`
 * returns these; the SoD loader projects them through
 * `orderEventTypeToPermission`.
 */
interface FakeHistoryRow {
  readonly eventType: string;
  readonly actorUserId: string | null;
  readonly sequenceNumber: number;
}

interface FakeOverrides {
  /**
   * Row returned by the factory's `SELECT … FOR UPDATE`. NULL means
   * "no row" — surfaces as ORDER_NOT_FOUND from the factory.
   *
   * Default: `{ currentStatus: "PV1_IN_PROGRESS", version: 3 }` —
   * the canonical pre-ApprovePV1 state.
   */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  policy?: { code: string; version: number; status: string } | null;
  fillBucketFound?: boolean;
  orderUpdateManyCount?: number;
  /** Head of `order_event` for sequence numbering (head + 1 is the next seq). */
  orderEventHead?: { sequenceNumber: number } | null;
  /**
   * SoD history rows returned by `orderEvent.findMany`. The default
   * is "this order has been through StartTyping (by TYPIST) and
   * CompleteTypingReview (by TYPIST) and StartPV1 (by the same
   * PHARMACIST who is now calling ApprovePV1)" — a healthy two-actor
   * separation that should NOT raise SoD.
   */
  history?: ReadonlyArray<FakeHistoryRow>;
  /**
   * Return value from `verification_record.create`. Defaults to
   * `{ id: VERIFICATION_RECORD_ID }`. Override to simulate an
   * id-shape change or a custom row.
   */
  verificationRecordCreate?: { id: string };
  /**
   * Clinical-screening inputs. Defaults to the gap-acknowledged
   * fixture so the pre-existing happy-path assertions still exercise
   * a successful approval — the screening gate is proved separately.
   */
  screening?: ScreeningStubOptions;
}

const DEFAULT_HEALTHY_HISTORY: ReadonlyArray<FakeHistoryRow> = [
  { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
  { eventType: "order.typing.started.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
  { eventType: "order.typing.completed.v1", actorUserId: TYPIST_ID, sequenceNumber: 3 },
  { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 4 },
];

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
  screening: ScreeningStubs;
} {
  const calls: FakeCall[] = [];
  const screening = createScreeningStubs(
    (table, op, args) => calls.push({ table, op, args }),
    overrides.screening ?? DEFAULT_SCREENING_STUBS
  );

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "PV1_IN_PROGRESS", version: 3 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const fillBucketFound = overrides.fillBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 4 };
  const history = overrides.history ?? DEFAULT_HEALTHY_HISTORY;
  const verificationRecordCreate = overrides.verificationRecordCreate ?? {
    id: VERIFICATION_RECORD_ID,
  };

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.PV1_ACTIVE
    ),
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policy === null ? null : { id: POLICY_ID, ...policy };
      }),
    },
    order: {
      ...screening.order,
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    orderLine: screening.orderLine,
    prescription: screening.prescription,
    orderScreeningFinding: screening.orderScreeningFinding,
    orderScreeningAcknowledgement: screening.orderScreeningAcknowledgement,
    patientAllergy: screening.patientAllergy,
    patientAllergyHistoryAssertion: screening.patientAllergyHistoryAssertion,
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
      // SoD path uses findMany (full history, sequenceNumber ASC).
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findMany", args });
        return history;
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
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
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

  return { client, calls, screening };
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
      { organizationId: ORG_ID, userId: PHARMACIST_ID, grants: orgWidePV1ApproveGrants },
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

describe("ApprovePV1 — happy path", () => {
  it("returns expected output and writes verification_record + order.update + factory CAS + order_event + audit + outbox", async () => {
    // Canonical chain: …seq=4 (StartPV1). ApprovePV1 = seq 5.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "PV1_APPROVED_READY_FOR_FILL",
      version: 4,
      transitionId: "wf.v1.approve_pv1",
      verificationRecordId: VERIFICATION_RECORD_ID,
    });

    // Lock fired exactly once.
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    // Policy load: by id (from the locked target).
    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Bucket lookup: FILL bucket sited from target.siteId.
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "FILL",
    });

    // verification_record write: APPROVED + null reasonCode
    // (DB CHECK constraint demands null for APPROVED rows).
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
      decision: "APPROVED",
      pharmacistUserId: PHARMACIST_ID,
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
      currentStatus: "PV1_APPROVED_READY_FOR_FILL",
      currentBucketId: FILL_BUCKET_ID,
      currentAssigneeUserId: null,
    });
    expect(updateArgs.data["version"]).toBeUndefined();

    // Factory CAS: keyed on (id, organizationId, version=3) → 4.
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 3 });
    expect(casArgs.data).toEqual({ version: 4 });

    // Two order_event rows: the approval (seq = head+1 = 5) and the
    // re-screen this approval was gated on (seq 6). Both belong on the
    // timeline — "approved" without "screened against what" is the
    // record that cannot answer the question that matters later.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(2);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.pv1.approved.v1",
      sequenceNumber: 5,
      actorUserId: PHARMACIST_ID,
    });
    expect((oeCreate[1]!.args as { data: Record<string, unknown> }).data).toMatchObject({
      eventType: "order.pv1.screening.recorded.v1",
      sequenceNumber: 6,
      actorUserId: PHARMACIST_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("explicitly clears currentAssigneeUserId to null (symmetric to CompleteTypingReview)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-clear" })
    );

    const updateArgs = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateArgs).toHaveProperty("currentAssigneeUserId", null);
  });

  it("emits order.pv1.approved.v1 outbox payload with scope + transition + ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-payload" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.pv1.approved.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      approvingPharmacistUserId: PHARMACIST_ID,
      bucketId: FILL_BUCKET_ID,
      transitionId: "wf.v1.approve_pv1",
      fromState: "PV1_IN_PROGRESS",
      toState: "PV1_APPROVED_READY_FOR_FILL",
      verificationRecordId: VERIFICATION_RECORD_ID,
      occurredAt: "2026-05-23T13:30:00.000Z",
    });
  });

  it("writes verification_record BEFORE order.update (constraint-failure ordering)", async () => {
    // Symmetric to RejectPV1's ordering invariant. Both
    // commands write the record first so a DB CHECK-constraint
    // failure surfaces a record-shaped error rather than an
    // "order updated but no record" inconsistency. The
    // atomicity is the same either way (single tx), but the
    // ordering matters for diagnosis.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-order" })
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

  it("audit metadata records transition + policy + bucket WITHOUT PHI", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-audit" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.pv1.approved",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "PV1_IN_PROGRESS",
      toState: "PV1_APPROVED_READY_FOR_FILL",
      transitionId: "wf.v1.approve_pv1",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: FILL_BUCKET_ID,
      approvingPharmacistUserId: PHARMACIST_ID,
      verificationRecordId: VERIFICATION_RECORD_ID,
    });
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId|drugName|ndc|sig/i);
  });
});

// ---------------------------------------------------------------------------
// Separation of Duties — the load-bearing new path
// ---------------------------------------------------------------------------

describe("ApprovePV1 — Separation of Duties (sod.typing-pv1-same-actor)", () => {
  it("loads order_event history via orderEvent.findMany BEFORE the handler's exec runs", async () => {
    // The defining structural assertion of this slice. Every prior
    // command in the codebase had `orderEvent.findFirst` calls only
    // (factory's seq+1 lookup). This is the first command where
    // `orderEvent.findMany` MUST be called — that's how the SoD
    // helper materializes the resource history for the rule check.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-sod-loadhistory" })
    );

    const findManyCalls = callsOf(fake.calls, "orderEvent", "findMany");
    expect(findManyCalls).toHaveLength(1);
    const args = findManyCalls[0]!.args as {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    // History scope: this order, ASC by sequenceNumber, only the
    // columns the projector needs (eventType, actorUserId, seq).
    // No payload, no PHI — the helper deliberately reads minimal
    // columns.
    expect(args.where).toEqual({ orderId: ORDER_ID });
    expect(args.orderBy).toEqual({ sequenceNumber: "asc" });
    expect(args.select).toEqual({
      eventType: true,
      actorUserId: true,
      sequenceNumber: true,
    });
  });

  it("raises SOD_VIOLATION when actor performed TYPING_COMPLETE on the same order", async () => {
    // The forbidden flow: the typist who completed typing IS the
    // pharmacist now attempting to approve PV1. This is the exact
    // case `sod.typing-pv1-same-actor` prevents.
    const violatingHistory: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.typing.started.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 2 },
      // PHARMACIST also completed typing — the colliding act:
      { eventType: "order.typing.completed.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 3 },
      { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 4 },
    ];
    const fake = buildPrismaFake({ history: violatingHistory });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-sod-violate" })
      ).rejects.toMatchObject({
        code: "SOD_VIOLATION",
        metadata: expect.objectContaining({
          ruleId: "sod.typing-pv1-same-actor",
          attemptedPermission: "pv1.approve",
          collidingPriorAct: "typing.complete",
          priorActSequence: "3",
          resourceRef: `order:${ORDER_ID}`,
          actorUserId: PHARMACIST_ID,
          organizationId: ORG_ID,
        }),
      });
    });

    // The SoD failure MUST roll back BEFORE the handler's exec —
    // zero domain mutations, zero new events, zero new audit/outbox
    // rows, and crucially ZERO verification_record writes (the
    // pharmacist's "approval intent" must not be persisted when the
    // attempt was forbidden).
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "bucket", "findFirst")).toHaveLength(0);
  });

  it("does NOT raise when TYPING_COMPLETE was performed by a different actor", async () => {
    // Different-actor immunity: the typist (TYPIST_ID) completed
    // typing; the pharmacist (PHARMACIST_ID) is approving. This is
    // the healthy two-actor flow — SoD must let it through.
    const fake = buildPrismaFake(); // default history has this shape
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-sod-different-actor" })
    );

    // Happy-path mutations all happened (proving SoD did NOT fire).
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    // Two: the approval and the screening record it was gated on.
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(2);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
  });

  it("does NOT raise when no TYPING_COMPLETE exists in history (e.g. legacy / migrated order)", async () => {
    // Edge case: an order somehow reached PV1_IN_PROGRESS without an
    // `order.typing.completed.v1` event in its history (data
    // migration, partial replay, etc.). The transition itself is
    // separately gated by the engine, but if it DID land here, SoD
    // has nothing to forbid — no prior act matches the rule's
    // forbiddenPriorActs set.
    const noTypingCompleteHistory: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.typing.started.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
      // typing.completed event is intentionally absent.
      { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 3 },
    ];
    const fake = buildPrismaFake({
      history: noTypingCompleteHistory,
      orderEventHead: { sequenceNumber: 3 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-sod-no-typing" })
    );

    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
  });

  it("ignores history rows with no actorUserId (system-emitted events)", async () => {
    // System-emitted events (`actorUserId: null`) MUST be skipped by
    // the SoD loader; otherwise a system event of type
    // `order.typing.completed.v1` would falsely raise.
    const systemEmittedTypingComplete: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.typing.started.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
      // actorUserId: null — a system event, NOT an actor act.
      { eventType: "order.typing.completed.v1", actorUserId: null, sequenceNumber: 3 },
      { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 4 },
    ];
    const fake = buildPrismaFake({ history: systemEmittedTypingComplete });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-sod-system" })
    );

    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
  });

  it("ignores history rows whose eventType is not in the translator", async () => {
    // Informational events (not in `ORDER_EVENT_TYPE_TO_PERMISSION`)
    // are silently skipped — they are not "acts" under SoD.
    const includesUnmappedEvent: ReadonlyArray<FakeHistoryRow> = [
      { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
      { eventType: "order.typing.started.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
      { eventType: "order.typing.completed.v1", actorUserId: TYPIST_ID, sequenceNumber: 3 },
      // Unmapped (informational) event by the would-be-violating actor;
      // even though PHARMACIST_ID performed it, it's not in the
      // translator so the loader skips it. (Defensive: an
      // `order.note.added.v1`-style event MUST NOT trigger SoD.)
      { eventType: "order.note.added.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 4 },
      { eventType: "order.pv1.started.v1", actorUserId: PHARMACIST_ID, sequenceNumber: 5 },
    ];
    const fake = buildPrismaFake({
      history: includesUnmappedEvent,
      orderEventHead: { sequenceNumber: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-sod-unmapped" })
    );

    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("ApprovePV1 — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
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
        executeCommand(ApprovePV1, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("ApprovePV1 — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    // SoD history load also short-circuits — policy failure is
    // step 2 of the factory; SoD is step 3.
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("unsupported policy version → PV1_POLICY_UNSUPPORTED (raised post-SoD, in the handler)", async () => {
    // Unlike WORKFLOW_POLICY_INACTIVE which the factory raises in
    // step 2 (so SoD never runs), the v2-unsupported check lives
    // INSIDE the handler — and the factory invokes SoD between
    // policy-load and exec. So findMany WILL have run for this
    // case. Pin that the policy-version error is the surfaced one
    // (not a SoD violation), but expect the SoD load to have
    // happened.
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in TYPED_READY_FOR_PV1 (PV1 not yet started) → PV1_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPED_READY_FOR_PV1", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already PV1_APPROVED_READY_FOR_FILL → PV1_INVALID_TRANSITION (no double-approve)", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_APPROVED_READY_FOR_FILL", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → PV1_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 7 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("FILL bucket missing → FILL_BUCKET_NOT_CONFIGURED, no verification_record / order update", async () => {
    // Bucket lookup happens BEFORE the verification_record
    // write inside exec, so a missing bucket short-circuits
    // ALL domain writes (record, order, CAS).
    const fake = buildPrismaFake({ fillBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    // The verification_record write DID happen inside the
    // tx (it's between bucket-resolve and order.update), but
    // when the CAS misses the WHOLE TX rolls back in production
    // — neither row lands in Postgres. The fake records every
    // call regardless of tx outcome, so we assert the
    // in-tx call ordering: vr.create + order.update both
    // happened, the CAS returned count=0, and downstream
    // bus writes (order_event/audit/outbox) never fired.
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
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
// The screening gate refuses — and commits its evidence
// ---------------------------------------------------------------------------

describe("ApprovePV1 — a gap nobody can close does not gate the approval", () => {
  it("approves a routine order with zero acknowledgements, and records all three gaps", async () => {
    // The behaviour this change exists to produce, asserted at the
    // command that actually gates.
    //
    // A default-configured deployment reports two gaps on every order
    // for a correctly-intaked patient: no licensed knowledge source is
    // wired, and the sig carries no structured dose. Before, each
    // demanded its own acknowledgement command — on 100% of orders, none
    // of them closable by the pharmacist being asked. That is an
    // override-rate machine, and the reflex it trains is the one that
    // dismisses the first genuine MAJOR interaction.
    //
    // Both halves matter here: no clicks, AND both gaps on the record.
    // Suppressing them would trade alert fatigue for a screen that reads
    // as clean, which is the worse failure.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const result = await withTenancyContext(ctxFor(), () =>
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-routine" })
    );

    expect(result.currentStatus).toBe("PV1_APPROVED_READY_FOR_FILL");
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);

    const rows = callsOf(fake.calls, "orderScreeningFinding", "createMany").flatMap(
      (c) => (c.args as { data: Array<Record<string, unknown>> }).data
    );
    expect(rows.map((r) => r["fingerprint"]).sort()).toEqual([...DEFAULT_GAP_FINGERPRINTS].sort());
    for (const row of rows) {
      expect(row["kind"]).toBe("SCREENING_GAP");
      expect(row["disposition"]).toBe("INFORMATIONAL");
      // Still stamped with the policy that governed the grading, so a
      // historical screen stays interpretable under its own policy.
      expect(row["workflowPolicyVersion"]).toBe(1);
      expect(row["minimumReportedSeverity"]).toBe("MINOR");
    }
  });

  it("refuses to approve for a patient whose allergy history was never taken", async () => {
    // The contrast that makes the grading model do work rather than just
    // describe itself. The ONLY difference from the test above is that
    // this patient has no allergy-history assertion — so the allergy axis
    // resolves NOT_RECORDED_FOR_SUBJECT instead of AVAILABLE, grades
    // MODERATE instead of not firing, and gates the approval.
    //
    // A gap interrupts exactly when somebody can close it. Nobody can
    // license a drug database from a PV1 queue; somebody can take an
    // allergy history.
    const fake = buildPrismaFake({
      screening: { ...DEFAULT_SCREENING_STUBS, historyAssertions: [] },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-no-allergy-history" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });

    const rows = callsOf(fake.calls, "orderScreeningFinding", "createMany").flatMap(
      (c) => (c.args as { data: Array<Record<string, unknown>> }).data
    );
    expect(rows.map((r) => r["fingerprint"])).toContain(ALLERGY_NOT_RECORDED_FINGERPRINT);
    const allergyGap = rows.find((r) => r["code"] === "SCR_ALLERGY_INPUT_UNAVAILABLE");
    expect(allergyGap).toMatchObject({
      severity: "MODERATE",
      disposition: "REQUIRES_ACKNOWLEDGEMENT",
    });

    // Refused, and no approval written.
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });
});

describe("ApprovePV1 — a screening refusal is a COMMITTED refusal", () => {
  /**
   * A PROVISIONED source that does not hold the candidate's NDC.
   *
   * The default empty source cannot produce a refusal any more, and
   * that is the fix, not an obstacle: its gaps are systemic and nobody
   * can close them. A provisioned database with one code missing is a
   * genuinely outstanding finding — check the NDC, chase a
   * reference-data update — so it is the honest way to exercise the
   * committed-refusal path.
   */
  beforeEach(() => {
    configureClinicalScreening({
      knowledgeSource: createInMemoryDrugKnowledgeSource({
        drugs: {
          "00000-0000-99": {
            ingredientCodes: ["INGREDIENT_ALFA"],
            uncodedIngredientCount: 0,
            therapeuticClassCodes: [],
            crossSensitivityClassCodes: [],
            doseRange: null,
          },
        },
      }),
    });
  });

  afterEach(() => {
    resetClinicalScreeningConfigurationForTests();
  });

  const OUTSTANDING_KNOWLEDGE_GAP_FINGERPRINT = `SCR_KNOWLEDGE_UNAVAILABLE|MODERATE/DEFINITE|${CANDIDATE_NDC}|remediation=SUBJECT_DATA;scope=CANDIDATE_DRUG`;
  const REFUSED_SCREEN_FINGERPRINTS: ReadonlyArray<string> = [
    OUTSTANDING_KNOWLEDGE_GAP_FINGERPRINT,
    DOSE_INPUT_GAP_FINGERPRINT,
  ];

  it("persists the screen it refused against and writes no approval", async () => {
    // The refusal is raised on findings, and the only place a
    // pharmacist can read or acknowledge a finding is
    // `order_screening_finding`. Rolling the screen back with the
    // refusal — which is what throwing from the handler does — leaves
    // them refused for something nothing can show them and nothing can
    // settle. So the rows land, the approval does not, and the error
    // is thrown after the commit.
    const fake = buildPrismaFake({ screening: DEFAULT_SCREENING_STUBS });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-refused" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        httpStatus: 422,
      });
    });

    const persisted = callsOf(fake.calls, "orderScreeningFinding", "createMany");
    expect(persisted).toHaveLength(1);
    const rows = (persisted[0]!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows.map((r) => r["fingerprint"]).sort()).toEqual(
      [...REFUSED_SCREEN_FINGERPRINTS].sort()
    );
    for (const row of rows) {
      expect(row["phase"]).toBe("PV1_APPROVE");
      expect(row["screenedForUserId"]).toBe(PHARMACIST_ID);
    }

    // Nothing about the approval happened.
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "bucket", "findFirst")).toHaveLength(0);
  });

  it("records the refused attempt on the timeline and in the audit log, and caches nothing", async () => {
    const fake = buildPrismaFake({ screening: DEFAULT_SCREENING_STUBS });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-refused-trail" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });

    const events = callsOf(fake.calls, "orderEvent", "create").map(
      (c) => (c.args as { data: Record<string, unknown> }).data["eventType"]
    );
    expect(events).toEqual(["order.pv1.screening.recorded.v1", "order.pv1.approval.refused.v1"]);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);

    // No idempotency row: the pharmacist's remedy is to acknowledge
    // and retry, and a cached refusal would answer that retry with
    // the refusal it was sent to resolve.
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(0);
  });

  it("carries no PHI into the refusal's audit metadata or event payload", async () => {
    const fake = buildPrismaFake({ screening: DEFAULT_SCREENING_STUBS });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "approve-refused-phi" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });

    const serialized = JSON.stringify(
      fake.calls
        .filter(
          (c) =>
            (c.table === "auditLog" && c.op === "create") ||
            (c.table === "eventOutbox" && c.op === "createMany")
        )
        .map((c) => c.args),
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    );
    expect(serialized).not.toContain(PATIENT_ID);
    expect(serialized).not.toMatch(/firstName|lastName|dateOfBirth|drugName|\bsig\b/i);
    // …and the refusal IS described, so the assertion above is not
    // passing on an empty bag.
    expect(serialized).toContain("PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("ApprovePV1 — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });

  it("missing PV1_APPROVE permission → PERMISSION_DENIED, no lock attempt", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    // Grant only PV1_START (not PV1_APPROVE) — pins the per-permission
    // boundary even within a single stage. A pharmacist can claim
    // the order for review (PV1_START) without being authorized to
    // sign off on it (PV1_APPROVE). In production these come
    // together via the `Pharmacist` role; the bus enforces them
    // independently.
    configureGrantsFor(PHARMACIST_ID, new Set([PERMISSIONS.PV1_START]));

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ApprovePV1, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderEvent", "findMany")).toHaveLength(0);
  });
});
