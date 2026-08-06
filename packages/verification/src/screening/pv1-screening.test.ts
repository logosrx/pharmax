// PV1 clinical screening — end-to-end contract tests across
// StartPV1 → AcknowledgePV1ScreeningFinding → ApprovePV1.
//
// These run the three commands against ONE stateful Prisma fake, so a
// finding persisted by StartPV1 is the same row the acknowledge
// command looks up and the same fingerprint the approval gate
// evaluates. Testing them in isolation would let the fingerprint
// contract drift between producer and consumer — which is the single
// most dangerous silent failure available here, because an
// acknowledgement that stops matching a finding does not error, it
// just stops suppressing an alert (or, worse, keeps suppressing one
// that has since become more severe).
//
// CLEAN ROOM: every drug code, ingredient code and interaction
// grading below is synthetic (`INGREDIENT_ALFA`, `00000-0000-01`).
// Pharmax ships no drug data and no test fixture may introduce any.
//
// PHI: no fixture carries a patient name or DOB. The one "drug name"
// string that appears is an obvious placeholder whose entire purpose
// is to be asserted ABSENT from every persisted row and payload.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryDrugKnowledgeSource,
  type DrugKnowledgeSource,
} from "@pharmax/clinical-screening";
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
} from "@pharmax/rbac";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import type { TenantTransactionClient } from "@pharmax/database";

import { AcknowledgePV1ScreeningFinding } from "../commands/acknowledge-pv1-screening-finding.js";
import { ApprovePV1 } from "../commands/approve-pv1.js";
import { StartPV1 } from "../commands/start-pv1.js";

import { patientRecordStateToken } from "./patient-scope.js";

import {
  configureClinicalScreening,
  resetClinicalScreeningConfigurationForTests,
} from "./configure.js";
import {
  createScreeningStubs,
  historyTakenNoKnownAllergies,
  screenableStubAllergy,
  type ScreeningStubOptions,
  type ScreeningStubs,
  type StubFinding,
} from "./test-support.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const BUCKET_ID = "00000000-0000-4000-8000-0000000000bb";
const PHARMACIST_A = "00000000-0000-4000-8000-0000000000a1";
const PHARMACIST_B = "00000000-0000-4000-8000-0000000000a2";
const TYPIST_ID = "00000000-0000-4000-8000-000000000088";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000d1";
const CANDIDATE_RX = "00000000-0000-4000-8000-0000000000e1";
const PROFILE_RX = "00000000-0000-4000-8000-0000000000e2";

const CANDIDATE_NDC = "00000-0000-01";
const PROFILE_NDC = "00000-0000-02";
/** Never selected by the screening path; asserted absent everywhere. */
const CANDIDATE_DRUG_NAME = "PLACEHOLDER-BRAND-NAME";

/**
 * Fingerprints, spelled out rather than imported.
 *
 * `fingerprintOf` is the contract between a finding and an
 * acknowledgement, and it is matched on equality and nothing else. If
 * its shape changes, every acknowledgement ever recorded silently
 * stops matching its finding — so the shape is pinned here in a form
 * that fails loudly rather than derived from the same function under
 * test.
 */
/**
 * The candidate NDC unrecognised by an UNPROVISIONED source — i.e. the
 * shipped default, where no licensed database is wired and every lookup
 * for every drug fails. MINOR, so recorded without interrupting.
 */
const GAP_FINGERPRINT = `SCR_KNOWLEDGE_UNAVAILABLE|MINOR/DEFINITE|${CANDIDATE_NDC}|remediation=PLATFORM_CAPABILITY;scope=CANDIDATE_DRUG`;
const INTERACTION_FINGERPRINT =
  "SCR_DRUG_INTERACTION|MAJOR/PROBABLE|INGREDIENT_ALFA+INGREDIENT_BRAVO";

/**
 * The dose gap every fixture in this suite carries: stub prescriptions
 * default to NO structured sig (`sigStructureKind` null), which is a
 * legacy transcription, and a prescription is immutable once written —
 * so `SCREENING_AXIS_CAPABILITY` resolves DOSE_RANGE to
 * NOT_CAPTURED_FOR_RECORD for the line and every screen RECORDS the
 * gap, including the screens below where the knowledge source knows
 * the drugs perfectly well.
 *
 * MINOR, therefore INFORMATIONAL, and that grading is the point.
 * Nobody touching the order can add a capture to an immutable record,
 * so an acknowledgement per order would collect a signature per
 * prescription against a fact nobody can change. The gap is still
 * written to `order_screening_finding` and still counted in
 * `gapCount`; what it does not do is gate an approval. (Before
 * structured sig existed this same code carried
 * remediation=PLATFORM_CAPABILITY — same severity, same disposition,
 * different sentence and therefore a different fingerprint.)
 *
 * DRUG_ALLERGY used to be an entry here, and is not any more.
 * Allergy capture exists, so the axis is per-patient: AVAILABLE for a
 * patient with screenable records or an asserted-empty history,
 * NOT_RECORDED_FOR_SUBJECT (MODERATE, acknowledge-tier) for a patient
 * nobody has asked. The fixtures below assert an empty history, so the
 * axis screens clear and raises nothing. See the "allergy axis" describe
 * block for the three states.
 *
 * The fingerprint carries no drug code: the fact is about the platform,
 * not the prescription.
 */
const DOSE_INPUT_GAP_FINGERPRINT =
  "SCR_DOSE_INPUT_UNAVAILABLE|MINOR/DEFINITE|DOSE_RANGE|remediation=RECORD_IMMUTABLE";
const UNSUPPLIED_AXIS_FINGERPRINTS: ReadonlyArray<string> = [DOSE_INPUT_GAP_FINGERPRINT];

/**
 * The per-patient allergy gap, for a patient nobody has asked. MODERATE
 * rather than MINOR because somebody can go and take a history, which
 * is what makes it worth interrupting for.
 */
const ALLERGY_NOT_RECORDED_FINGERPRINT =
  "SCR_ALLERGY_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DRUG_ALLERGY|remediation=SUBJECT_DATA";

const HEALTHY_HISTORY = [
  { eventType: "order.received.v1", actorUserId: TYPIST_ID, sequenceNumber: 1 },
  { eventType: "order.typing.started.v1", actorUserId: TYPIST_ID, sequenceNumber: 2 },
  { eventType: "order.typing.completed.v1", actorUserId: TYPIST_ID, sequenceNumber: 3 },
];

function ctxFor(userId: string): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId, correlationId: "01CORRELATION0000000000000" },
  });
}

/**
 * A knowledge source that knows both synthetic drugs and grades the
 * pair MAJOR / PROBABLE — the acknowledge tier, which is where the
 * interesting behaviour lives.
 */
function knowledgeWithAcknowledgeTierInteraction(): DrugKnowledgeSource {
  return createInMemoryDrugKnowledgeSource({
    drugs: {
      [CANDIDATE_NDC]: {
        ingredientCodes: ["INGREDIENT_ALFA"],
        uncodedIngredientCount: 0,
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: null,
      },
      [PROFILE_NDC]: {
        ingredientCodes: ["INGREDIENT_BRAVO"],
        uncodedIngredientCount: 0,
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: null,
      },
    },
    interactions: [
      {
        ingredients: ["INGREDIENT_ALFA", "INGREDIENT_BRAVO"],
        fact: { severity: "MAJOR", certainty: "PROBABLE", citation: null },
      },
    ],
  });
}

/**
 * The same pair graded CONTRAINDICATED / DEFINITE — the only grading
 * an adapter can emit that reaches HARD_STOP.
 */
function knowledgeWithHardStopInteraction(): DrugKnowledgeSource {
  return createInMemoryDrugKnowledgeSource({
    drugs: {
      [CANDIDATE_NDC]: {
        ingredientCodes: ["INGREDIENT_ALFA"],
        uncodedIngredientCount: 0,
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: null,
      },
      [PROFILE_NDC]: {
        ingredientCodes: ["INGREDIENT_BRAVO"],
        uncodedIngredientCount: 0,
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: null,
      },
    },
    interactions: [
      {
        ingredients: ["INGREDIENT_ALFA", "INGREDIENT_BRAVO"],
        fact: { severity: "CONTRAINDICATED", certainty: "DEFINITE", citation: null },
      },
    ],
  });
}

const candidateOnly: ScreeningStubOptions = {
  patientId: PATIENT_ID,
  orderLinePrescriptionIds: [CANDIDATE_RX],
  // History taken and empty, so the DRUG_ALLERGY axis is AVAILABLE and
  // screens clear. Stated explicitly because a fixture that says nothing
  // about allergies is a patient nobody has asked, which is now an
  // acknowledge-tier gap — correct behaviour, and not what these tests
  // are about.
  historyAssertions: [historyTakenNoKnownAllergies(PATIENT_ID)],
  prescriptions: [
    {
      id: CANDIDATE_RX,
      patientId: PATIENT_ID,
      drugNdc: CANDIDATE_NDC,
      status: "ACTIVE",
      drugName: CANDIDATE_DRUG_NAME,
    },
  ],
};

const candidateAndInteractingProfileDrug: ScreeningStubOptions = {
  ...candidateOnly,
  prescriptions: [
    ...(candidateOnly.prescriptions ?? []),
    {
      id: PROFILE_RX,
      patientId: PATIENT_ID,
      drugNdc: PROFILE_NDC,
      status: "ACTIVE",
      drugName: "PLACEHOLDER-PROFILE-NAME",
    },
  ],
};

// ---------------------------------------------------------------------------
// Stateful Prisma fake
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FlowFakeOptions {
  readonly screening?: ScreeningStubOptions;
  readonly initialStatus?: string;
}

interface FlowFake {
  readonly client: unknown;
  readonly calls: FakeCall[];
  readonly screening: ScreeningStubs;
  readonly currentStatus: () => string;
}

function buildFlowFake(options: FlowFakeOptions = {}): FlowFake {
  const calls: FakeCall[] = [];
  const record = (table: string, op: string, args: unknown): void => {
    calls.push({ table, op, args });
  };
  const screening = createScreeningStubs(record, options.screening ?? candidateOnly);

  let currentStatus = options.initialStatus ?? "TYPED_READY_FOR_PV1";
  let version = 2;
  let eventSeq = HEALTHY_HISTORY.length;

  const idempotency = new Map<
    string,
    { requestHash: string; responsePayload: unknown; responseStatus: number | null }
  >();
  const idempotencyKeyOf = (args: unknown): string => {
    const where = (args as { where: { organizationId_commandName_key: Record<string, string> } })
      .where.organizationId_commandName_key;
    return `${where["commandName"]}\u0000${where["key"]}`;
  };

  const tx = {
    // WAIT_BEFORE_PV1 is what is open when a pharmacist claims the
    // order; StartPV1 closes it and opens PV1_ACTIVE, which
    // ApprovePV1 then closes. The stub tracks the transition, so the
    // whole flow runs against one interval timeline.
    orderStageInterval: createOrderStageIntervalTxStub(
      record,
      OrderStageIntervalKind.WAIT_BEFORE_PV1
    ),
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        record("workflowPolicy", "findUnique", args);
        return { id: POLICY_ID, code: "order.standard", version: 1, status: "ACTIVE" };
      }),
    },
    order: {
      ...screening.order,
      update: vi.fn(async (args: unknown) => {
        record("order", "update", args);
        const data = (args as { data: Record<string, unknown> }).data;
        if (typeof data["currentStatus"] === "string") currentStatus = data["currentStatus"];
        return { id: ORDER_ID };
      }),
      // A real compare-and-swap, not a canned count. Two commands
      // that locked at the same version must not both succeed here,
      // and modelling that faithfully is the only way the
      // concurrency test proves anything.
      updateMany: vi.fn(async (args: unknown) => {
        record("order", "updateMany", args);
        const { where, data } = args as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        if (where["version"] !== version) return { count: 0 };
        if (typeof data["version"] === "number") version = data["version"];
        return { count: 1 };
      }),
    },
    orderLine: screening.orderLine,
    prescription: screening.prescription,
    orderScreeningFinding: screening.orderScreeningFinding,
    orderScreeningAcknowledgement: screening.orderScreeningAcknowledgement,
    patientScreeningAcknowledgement: screening.patientScreeningAcknowledgement,
    patientAllergy: screening.patientAllergy,
    patientAllergyHistoryAssertion: screening.patientAllergyHistoryAssertion,
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        record("bucket", "findFirst", args);
        return { id: BUCKET_ID };
      }),
    },
    verificationRecord: {
      create: vi.fn(async (args: unknown) => {
        record("verificationRecord", "create", args);
        return { id: "00000000-0000-4000-8000-0000000000ff" };
      }),
    },
    orderEvent: {
      findMany: vi.fn(async (args: unknown) => {
        record("orderEvent", "findMany", args);
        return HEALTHY_HISTORY;
      }),
      findFirst: vi.fn(async (args: unknown) => {
        record("orderEvent", "findFirst", args);
        return { sequenceNumber: eventSeq };
      }),
      create: vi.fn(async (args: unknown) => {
        record("orderEvent", "create", args);
        eventSeq += 1;
        return { id: `oe-${eventSeq}` };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        record("commandLog", "create", args);
        return { id: "cl-1" };
      }),
      update: vi.fn(async (args: unknown) => {
        record("commandLog", "update", args);
        return { ok: true };
      }),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        record("auditLog", "create", args);
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: unknown) => {
        record("auditChainState", "upsert", args);
        return { organizationId: ORG_ID, latestHash: Buffer.alloc(32), latestSeq: 1n };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        record("eventOutbox", "createMany", args);
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        record("idempotencyKey", "create", args);
        const data = (args as { data: Record<string, unknown> }).data;
        idempotency.set(`${String(data["commandName"])}\u0000${String(data["key"])}`, {
          requestHash: String(data["requestHash"]),
          responsePayload: data["responsePayload"],
          responseStatus: null,
        });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        record("idempotencyKey", "findUnique", args);
        return idempotency.get(idempotencyKeyOf(args)) ?? null;
      }),
    },
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      if (/\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)) {
        record("$queryRaw", "select_for_update_order", { sql: joined, values: [...values] });
        return [
          {
            id: ORDER_ID,
            organizationId: ORG_ID,
            clinicId: CLINIC_ID,
            siteId: SITE_ID,
            currentBucketId: BUCKET_ID,
            currentStatus,
            version,
            workflowPolicyId: POLICY_ID,
            workflowPolicyVersion: 1,
          },
        ];
      }
      record("$queryRaw", "raw", { sql: joined, values: [...values] });
      return [];
    }),
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        record("commandLog", "create", args);
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        record("commandLog", "update", args);
        return { ok: true };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        record("idempotencyKey", "findUnique", args);
        return idempotency.get(idempotencyKeyOf(args)) ?? null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls, screening, currentStatus: () => currentStatus };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-07T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

const PV1_PERMISSIONS: ReadonlySet<PermissionCode> = new Set([
  PERMISSIONS.PV1_START,
  PERMISSIONS.PV1_APPROVE,
]);

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader(
      [PHARMACIST_A, PHARMACIST_B].map((userId) => ({
        organizationId: ORG_ID,
        userId,
        grants: [
          {
            roleScope: RoleScope.ORGANIZATION,
            grantScope: { siteId: null, clinicId: null, teamId: null },
            permissions: new Set(PV1_PERMISSIONS),
          },
        ],
      }))
    ),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetClinicalScreeningConfigurationForTests();
});

/** StartPV1 as pharmacist A, so an order is under review. */
async function startReview(keySuffix = "start"): Promise<void> {
  await withTenancyContext(ctxFor(PHARMACIST_A), () =>
    executeCommand(StartPV1, { orderId: ORDER_ID }, { idempotencyKey: `${keySuffix}` })
  );
}

/** Acknowledge specific fingerprints as one pharmacist. */
async function acknowledge(
  pharmacistUserId: string,
  fingerprints: ReadonlyArray<string>,
  keyPrefix: string
): Promise<void> {
  for (const [index, fingerprint] of fingerprints.entries()) {
    await withTenancyContext(ctxFor(pharmacistUserId), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint },
        { idempotencyKey: `${keyPrefix}-${index}` }
      )
    );
  }
}

/**
 * Every fingerprint the screens so far have persisted that still
 * needs a pharmacist's decision.
 *
 * Read from the persisted rows rather than listed literally, so a
 * test that means "the pharmacist worked through the list" does not
 * quietly stop covering an axis the day another one is added.
 */
function outstandingFingerprints(fake: FlowFake): ReadonlyArray<string> {
  return [
    ...new Set(
      fake.screening.state.persistedFindings
        .filter((f) => f.disposition === "REQUIRES_ACKNOWLEDGEMENT")
        .map((f) => f.fingerprint)
    ),
  ];
}

// ---------------------------------------------------------------------------
// The dose axis, end to end
// ---------------------------------------------------------------------------

describe("PV1 screening — the dose axis is per-line", () => {
  // What a pharmacist actually meets for each structured-sig state,
  // asserted through the real commands for the same reason the allergy
  // block below is: "what happens at sign-off" is decided by the gate
  // reading persisted rows, not by any resolver in isolation.

  /** The candidate line, transcribed with a structured FIXED sig. */
  const structuredFixedCandidate: ScreeningStubOptions = {
    ...candidateOnly,
    prescriptions: [
      {
        id: CANDIDATE_RX,
        patientId: PATIENT_ID,
        drugNdc: CANDIDATE_NDC,
        status: "ACTIVE",
        drugName: CANDIDATE_DRUG_NAME,
        sigStructureKind: "FIXED",
        doseAmount: 10,
        doseUnit: "MG",
        dosesPerDay: 3,
      },
    ],
  };

  /**
   * A source that knows the drug AND declares a dosing envelope below
   * the prescribed daily total — the seeded stand-in for licensed
   * dosing content, which is what proves the end-to-end path today.
   */
  function knowledgeWithLowDailyMaximum(): DrugKnowledgeSource {
    return createInMemoryDrugKnowledgeSource({
      drugs: {
        [CANDIDATE_NDC]: {
          ingredientCodes: ["INGREDIENT_ALFA"],
          uncodedIngredientCount: 0,
          therapeuticClassCodes: [],
          crossSensitivityClassCodes: [],
          doseRange: {
            unit: "mg",
            maxSingleDose: null,
            maxDailyDose: 20,
            minDailyDose: null,
            citation: "synthetic fixture",
          },
        },
      },
    });
  }

  it("a structured sig over seeded dose knowledge: a MAJOR finding that gates sign-off until acknowledged", async () => {
    const fake = buildFlowFake({ screening: structuredFixedCandidate });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithLowDailyMaximum() });

    await startReview();

    // 10mg x3/day against a 20mg/day envelope: the axis genuinely
    // computed. MAJOR, therefore acknowledge-tier — never a hard
    // stop, because a dosing range is a population statement.
    const doseRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DOSE_ABOVE_DAILY_MAXIMUM"
    );
    expect(doseRow).toMatchObject({
      severity: "MAJOR",
      disposition: "REQUIRES_ACKNOWLEDGEMENT",
    });
    // The magnitude and the basis are the identity — an acknowledged
    // 30mg must not suppress a later 300mg (see `fingerprintOf`).
    expect(doseRow?.fingerprint).toContain("dailyTotal=30mg");
    expect(doseRow?.fingerprint).toContain("basis=SCHEDULED");

    // No dose gap of any kind: the line was structured and the
    // content was provisioned, so the axis ran for real.
    const persistedCodes = fake.screening.state.persistedFindings.map((f) => f.code);
    expect(persistedCodes).not.toContain("SCR_DOSE_INPUT_UNAVAILABLE");
    expect(persistedCodes).not.toContain("SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED");

    // And it gates until the pharmacist decides.
    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-dose-block" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });

    await acknowledge(PHARMACIST_A, outstandingFingerprints(fake), "ack-dose");
    await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-dose-ok" })
    );
    expect(fake.currentStatus()).toBe("PV1_APPROVED_READY_FOR_FILL");
  });

  it("a structured sig with no dose-range content: an informational knowledge gap, not a false clear", async () => {
    // The honest production shape. The source knows the DRUG (so no
    // SCR_KNOWLEDGE_UNAVAILABLE) but licenses no dosing envelope for
    // anything — RxNorm's posture — and the record must say the dose
    // was not compared rather than reading like a dose that passed.
    const fake = buildFlowFake({ screening: structuredFixedCandidate });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    const gapRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED"
    );
    expect(gapRow).toMatchObject({
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
    // Informational: recorded on the order, gating nothing — only
    // procurement can close it, and the pharmacist begins with
    // nothing to click.
    expect(outstandingFingerprints(fake)).toEqual([]);
  });

  it("a bare PRN sig is structured and honestly numberless: no gap, no finding, no false clear either way", async () => {
    // "As needed" with no captured amount or ceiling. The axis is
    // AVAILABLE (somebody structured the sig; PRN is an answer), and
    // the line contributes no comparable number — which is a fact
    // about the prescription, not a gap in the platform or the
    // record.
    const fake = buildFlowFake({
      screening: {
        ...candidateOnly,
        prescriptions: [
          {
            id: CANDIDATE_RX,
            patientId: PATIENT_ID,
            drugNdc: CANDIDATE_NDC,
            status: "ACTIVE",
            drugName: CANDIDATE_DRUG_NAME,
            sigStructureKind: "PRN",
          },
        ],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithLowDailyMaximum() });

    await startReview();

    const persistedCodes = fake.screening.state.persistedFindings.map((f) => f.code);
    expect(persistedCodes.filter((code) => code.startsWith("SCR_DOSE"))).toEqual([]);
    expect(outstandingFingerprints(fake)).toEqual([]);
  });

  it("a PRN with a stated ceiling screens the maximum the prescription permits", async () => {
    // "10mg as needed, max 4 doses/day" PERMITS 40mg against a
    // 20mg/day envelope. That the patient may take less is exactly the
    // pharmacist's judgement to apply, which is why the finding is
    // acknowledge-tier and worded as a permission.
    const fake = buildFlowFake({
      screening: {
        ...candidateOnly,
        prescriptions: [
          {
            id: CANDIDATE_RX,
            patientId: PATIENT_ID,
            drugNdc: CANDIDATE_NDC,
            status: "ACTIVE",
            drugName: CANDIDATE_DRUG_NAME,
            sigStructureKind: "PRN",
            doseAmount: 10,
            doseUnit: "MG",
            dosesPerDay: 4,
          },
        ],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithLowDailyMaximum() });

    await startReview();

    const doseRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DOSE_ABOVE_DAILY_MAXIMUM"
    );
    expect(doseRow).toMatchObject({ severity: "MAJOR", disposition: "REQUIRES_ACKNOWLEDGEMENT" });
    expect(doseRow?.fingerprint).toContain("basis=MAXIMUM_PERMITTED");
  });

  it("a mixed order screens its structured line and gaps only its legacy line", async () => {
    // The reason the axis is per-LINE. One order, two prescriptions:
    // the structured one earns a real dose finding, the legacy one an
    // informational record-immutable gap — and neither statement
    // bleeds onto the other line.
    const fake = buildFlowFake({
      screening: {
        ...structuredFixedCandidate,
        orderLinePrescriptionIds: [CANDIDATE_RX, PROFILE_RX],
        prescriptions: [
          ...(structuredFixedCandidate.prescriptions ?? []),
          {
            id: PROFILE_RX,
            patientId: PATIENT_ID,
            drugNdc: CANDIDATE_NDC,
            status: "ACTIVE",
            drugName: "PLACEHOLDER-PROFILE-NAME",
            // No structured sig: a legacy transcription.
          },
        ],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithLowDailyMaximum() });

    await startReview();

    const persistedCodes = fake.screening.state.persistedFindings.map((f) => f.code);
    expect(persistedCodes).toContain("SCR_DOSE_ABOVE_DAILY_MAXIMUM");
    expect(persistedCodes).toContain("SCR_DOSE_INPUT_UNAVAILABLE");

    const gapRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DOSE_INPUT_UNAVAILABLE"
    );
    expect(gapRow).toMatchObject({
      fingerprint: DOSE_INPUT_GAP_FINGERPRINT,
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
  });
});

// ---------------------------------------------------------------------------
// The allergy axis, end to end
// ---------------------------------------------------------------------------

describe("PV1 screening — the allergy axis is per-patient", () => {
  // What a pharmacist actually meets, for each of the three states the
  // allergy-capture slice exists to distinguish. Asserted through the
  // real commands rather than against `resolveInputAvailability`, because
  // the question these answer is "what happens at sign-off", and that is
  // decided by the gate reading persisted rows.
  //
  // The knowledge source is the shipped empty one throughout, which is
  // the honest production configuration and is exactly why gate (b)
  // shows up in every case below: `SCR_KNOWLEDGE_UNAVAILABLE` fires,
  // graded MINOR because nobody in the pharmacy can license a database.
  // Having the allergies does not let the engine compare them to
  // anything — that needs NDC → ingredient resolution — and these tests
  // pin that the record says so rather than implying otherwise.

  it("a patient nobody has asked: an acknowledge-tier gap that BLOCKS sign-off", async () => {
    const fake = buildFlowFake({
      screening: { ...candidateOnly, historyAssertions: [] },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    // The gap is graded MODERATE, therefore acknowledge-tier, because
    // somebody CAN go and take an allergy history. That is the whole
    // difference from the old NOT_SUPPORTED_BY_PLATFORM value, which
    // graded MINOR and asked nothing of anybody.
    expect(outstandingFingerprints(fake)).toEqual([ALLERGY_NOT_RECORDED_FINGERPRINT]);

    const allergyRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_ALLERGY_INPUT_UNAVAILABLE"
    );
    expect(allergyRow).toMatchObject({
      severity: "MODERATE",
      disposition: "REQUIRES_ACKNOWLEDGEMENT",
    });

    // And it genuinely gates: an approval without the acknowledgement
    // is refused, which is what makes the gap more than a label.
    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-blocked" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });
    expect(fake.currentStatus()).toBe("PV1_IN_PROGRESS");
  });

  it("a patient asserted to have no known allergies: the axis screens CLEAR", async () => {
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    // No allergy finding of ANY kind — not a gap, not a clinical
    // finding. The axis ran against an empty list because somebody
    // asserted the list is empty, which is the one thing an allergy
    // table alone could never express.
    expect(
      fake.screening.state.persistedFindings.filter((f) => f.code.startsWith("SCR_DRUG_ALLERGY"))
    ).toEqual([]);
    expect(
      fake.screening.state.persistedFindings.filter(
        (f) => f.code === "SCR_ALLERGY_INPUT_UNAVAILABLE"
      )
    ).toEqual([]);
    expect(outstandingFingerprints(fake)).toEqual([]);

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-clear" })
      ).resolves.toMatchObject({ currentStatus: "PV1_APPROVED_READY_FOR_FILL" });
    });
  });

  it("a patient with recorded allergies: the axis runs, and gate (b) is what stops it", async () => {
    // THE MOST IMPORTANT TEST IN THIS FILE for reading the slice
    // honestly. The allergy input is present and passed to the engine —
    // gate (a) is open. No allergy finding comes back anyway, because
    // `describeDrug` returns null for the candidate with no knowledge
    // source wired, so the engine cannot reach the allergy comparison at
    // all.
    //
    // That is not a silent pass. `SCR_KNOWLEDGE_UNAVAILABLE` is on the
    // record saying no screening could be performed for this
    // prescription, which is true and covers the allergy axis. The gap
    // has MOVED from "the platform cannot hold allergies" (false, once
    // the table exists) to "no drug knowledge is provisioned" (true).
    const fake = buildFlowFake({
      screening: {
        ...candidateOnly,
        historyAssertions: [],
        allergies: [screenableStubAllergy({ patientId: PATIENT_ID })],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    const codes = fake.screening.state.persistedFindings.map((f) => f.code);
    // Gate (a) open: no "nobody recorded allergies" gap.
    expect(codes).not.toContain("SCR_ALLERGY_INPUT_UNAVAILABLE");
    // Gate (b) closed, and SAYING so.
    expect(codes).toContain("SCR_KNOWLEDGE_UNAVAILABLE");
    // No allergy finding, because no comparison was possible.
    expect(codes.filter((c) => c.startsWith("SCR_DRUG_ALLERGY"))).toEqual([]);

    // Nothing is outstanding: the knowledge gap is MINOR because no
    // pharmacist can license a database from a PV1 queue. So the order
    // approves — with an honest record that nothing was screened.
    expect(outstandingFingerprints(fake)).toEqual([]);
    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-recorded" })
      ).resolves.toMatchObject({ currentStatus: "PV1_APPROVED_READY_FOR_FILL" });
    });
  });

  it("with knowledge provisioned, a recorded allergy to the dispensed ingredient HARD STOPS", async () => {
    // Both gates open, in the one configuration where that is currently
    // possible: a seeded in-memory knowledge source. This is what the
    // slice buys the day an RxNorm or licensed adapter is wired, and it
    // is the reason a dark allergy axis mattered — allergy is the only
    // axis that can refuse a dispense outright.
    const fake = buildFlowFake({
      screening: {
        ...candidateOnly,
        historyAssertions: [],
        allergies: [
          screenableStubAllergy({
            patientId: PATIENT_ID,
            substanceCode: "INGREDIENT_ALFA",
            criticality: "HIGH",
            verificationStatus: "CONFIRMED",
          }),
        ],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    const allergyFinding = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DRUG_ALLERGY_DIRECT"
    );
    expect(allergyFinding).toMatchObject({
      severity: "CONTRAINDICATED",
      certainty: "DEFINITE",
      disposition: "HARD_STOP",
    });

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-hardstop" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });
    });
    expect(fake.currentStatus()).toBe("PV1_IN_PROGRESS");
  });

  it("an allergy recorded between StartPV1 and ApprovePV1 is caught by the re-screen", async () => {
    // The mid-review case, applied to the axis that can hard stop. The
    // pharmacist opens an order for a patient nobody has asked, a
    // technician takes an allergy history while they read it, and the
    // re-screen at sign-off must see it. Gating on the start-time
    // snapshot would approve against a world where the allergy was not
    // yet known.
    const fake = buildFlowFake({
      screening: { ...candidateOnly, historyAssertions: [] },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();
    // At start: nobody has asked, so an acknowledge-tier gap. The
    // pharmacist works through it.
    expect(outstandingFingerprints(fake)).toEqual([ALLERGY_NOT_RECORDED_FINGERPRINT]);
    await acknowledge(PHARMACIST_A, outstandingFingerprints(fake), "ack-gap");

    // …and now a technician records a high-criticality allergy to the
    // ingredient being dispensed.
    fake.screening.state.allergies.push(
      screenableStubAllergy({
        patientId: PATIENT_ID,
        substanceCode: "INGREDIENT_ALFA",
        criticality: "HIGH",
        verificationStatus: "CONFIRMED",
      })
    );

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-rescreen" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });
    });
    expect(fake.currentStatus()).toBe("PV1_IN_PROGRESS");
  });

  it("carries no substance narrative into a persisted finding", async () => {
    // Findings are codes only. A substance CODE is a code and is
    // allowed; `substanceLabelEnc` is narrative and must never be
    // selected by the screening path, let alone persisted. The stub row
    // cannot even carry a label, which is the structural half of this
    // guarantee — this is the behavioural half.
    const fake = buildFlowFake({
      screening: {
        ...candidateOnly,
        historyAssertions: [],
        allergies: [
          screenableStubAllergy({ patientId: PATIENT_ID, substanceCode: "INGREDIENT_ALFA" }),
        ],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    const serialized = JSON.stringify(
      callsOf(fake.calls, "orderScreeningFinding", "createMany").map((c) => c.args)
    );
    expect(serialized).not.toContain(PATIENT_ID);
    expect(serialized).not.toContain("substanceLabel");
    expect(serialized).not.toContain("reactionNote");
  });
});

// ---------------------------------------------------------------------------
// Compound-formula attribution and partial coding
// ---------------------------------------------------------------------------

describe("PV1 screening — compound formulas", () => {
  const FORMULA_ID = "00000000-0000-4000-8000-00000000f0f0";

  /**
   * A source modelling the composite: the candidate resolves from an
   * org-declared formula (one row still uncoded), and the source
   * names the formula version behind that answer.
   */
  function knowledgeFromPartiallyCodedFormula(): DrugKnowledgeSource {
    return createInMemoryDrugKnowledgeSource({
      drugs: {
        [CANDIDATE_NDC]: {
          ingredientCodes: ["INGREDIENT_ALFA"],
          uncodedIngredientCount: 1,
          therapeuticClassCodes: [],
          crossSensitivityClassCodes: [],
          doseRange: null,
        },
      },
      compoundProvenance: {
        [CANDIDATE_NDC]: {
          formulaId: FORMULA_ID,
          formulaCode: "F-SYNTH",
          formulaVersion: 3,
        },
      },
    });
  }

  it("stamps the formula version on formula-derived findings, and only those", async () => {
    const fake = buildFlowFake({
      screening: {
        ...candidateOnly,
        historyAssertions: [],
        allergies: [
          screenableStubAllergy({
            patientId: PATIENT_ID,
            substanceCode: "INGREDIENT_ALFA",
            criticality: "HIGH",
            verificationStatus: "CONFIRMED",
          }),
        ],
      },
    });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeFromPartiallyCodedFormula() });

    await startReview();

    // The hard stop the coded rows made possible names the recipe
    // version it was screened against — the org-formulary counterpart
    // of the knowledge-release stamp.
    const allergyRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DRUG_ALLERGY_DIRECT"
    );
    expect(allergyRow).toMatchObject({
      disposition: "HARD_STOP",
      formulaId: FORMULA_ID,
      formulaCode: "F-SYNTH",
      formulaVersion: 3,
    });

    // The partial-coding report is attributed to the same version —
    // "which recipe had the uncoded rows?" is its reader's question —
    // and is informational: org-closable, not the pharmacist's click.
    const partialRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED"
    );
    expect(partialRow).toMatchObject({
      disposition: "INFORMATIONAL",
      formulaId: FORMULA_ID,
      formulaVersion: 3,
    });

    // A caller-input gap on the same candidate consulted no recipe,
    // so it must not claim one — even though its trigger names the
    // same prescription line.
    const doseGapRow = fake.screening.state.persistedFindings.find(
      (f) => f.code === "SCR_DOSE_INPUT_UNAVAILABLE"
    );
    expect(doseGapRow).toMatchObject({ formulaId: null, formulaVersion: null });
  });
});

// ---------------------------------------------------------------------------
// The empty knowledge source — the shipped default
// ---------------------------------------------------------------------------

describe("PV1 screening — with no drug knowledge configured", () => {
  it("records a gap rather than a clear screen", async () => {
    // The single most important behaviour in this feature. Pharmax
    // ships no drug data, so out of the box the engine can answer
    // none of its questions. It must SAY that, rather than return "no
    // findings", which a pharmacist reads as "clinically clear".
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    const persisted = callsOf(fake.calls, "orderScreeningFinding", "createMany");
    expect(persisted).toHaveLength(1);
    const rows = (persisted[0]!.args as { data: Array<Record<string, unknown>> }).data;
    // Three separate things could not be checked, and each is its own
    // fact with its own owner: no licensed database is wired at all,
    // and this platform can supply neither an allergy list nor a
    // structured dose.
    expect(rows.map((r) => r["fingerprint"])).toEqual(
      expect.arrayContaining([GAP_FINGERPRINT, DOSE_INPUT_GAP_FINGERPRINT])
    );
    for (const row of rows) {
      expect(row).toMatchObject({ kind: "SCREENING_GAP", phase: "PV1_START" });
    }
  });

  it("does not charge the pharmacist an acknowledgement for a deficiency they cannot fix", async () => {
    // THE ALERT-FATIGUE INVARIANT, at the level a pharmacist meets it.
    //
    // In a default-configured deployment two gaps fire on EVERY order:
    // nobody has licensed a drug database, and no sig carries a
    // structured dose. Neither is closable from a PV1 queue. Demanding
    // an acknowledgement each, per prescription, would train the reflex
    // that dismisses the first genuine MAJOR interaction, and file a
    // documented sign-off implying a review that could not have
    // happened — worse than no screening, because it manufactures the
    // evidence too.
    //
    // The allergy gap was a third such gap until allergy capture landed
    // and is deliberately absent from this test: for a patient nobody
    // has asked it is now MODERATE and DOES ask for a click, because
    // somebody can go and take a history. This fixture's patient has one
    // on file, which is why the axis is silent here. The distinction is
    // the whole grading model — a gap interrupts exactly when it is
    // closable.
    //
    // So the approval passes with no clicks, and the gaps are on record.
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    expect(outstandingFingerprints(fake)).toEqual([]);

    const approval = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
    );
    expect(approval.currentStatus).toBe("PV1_APPROVED_READY_FOR_FILL");
    // Zero acknowledgement commands were needed to get here.
    expect(callsOf(fake.calls, "orderScreeningAcknowledgement", "create")).toHaveLength(0);

    // And the gaps are still recorded against the approval itself, so
    // "was this order screened?" is answerable from the row set.
    const approvePhaseRows = callsOf(fake.calls, "orderScreeningFinding", "createMany")
      .flatMap((c) => (c.args as { data: Array<Record<string, unknown>> }).data)
      .filter((r) => r["phase"] === "PV1_APPROVE");
    expect(approvePhaseRows.map((r) => r["code"])).toEqual(
      expect.arrayContaining(["SCR_KNOWLEDGE_UNAVAILABLE", "SCR_DOSE_INPUT_UNAVAILABLE"])
    );
    // And the allergy axis is silent, because this patient's history was
    // taken. That is the axis reporting CLEAR, not the axis being off.
    expect(approvePhaseRows.map((r) => r["code"])).not.toContain("SCR_ALLERGY_INPUT_UNAVAILABLE");
  });

  it("records the axis this platform cannot supply even when the drug IS known", async () => {
    // The regression that motivated the input-availability
    // declaration. Wiring a licensed knowledge source silences
    // SCR_KNOWLEDGE_UNAVAILABLE and makes interaction and duplication
    // screen for real — and, before this, a prescription would then
    // come back CLEAR having never been compared against an allergy
    // list that did not exist. Allergy is the only axis that can produce
    // a hard stop, so it was the axis most capable of saving someone
    // that was silently not running.
    //
    // Allergy capture has since landed, so that axis is per-patient and
    // this fixture's patient has an asserted-empty history: the axis
    // runs and finds nothing. DOSE_RANGE is what remains unsupportable,
    // and it is recorded without interrupting.
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    const rows = callsOf(fake.calls, "orderScreeningFinding", "createMany").flatMap(
      (c) => (c.args as { data: Array<Record<string, unknown>> }).data
    );
    expect(rows.map((r) => r["code"])).toEqual(
      expect.arrayContaining(["SCR_DOSE_INPUT_UNAVAILABLE"])
    );
    // Nothing pretends the drug is unknown — it is not.
    expect(rows.map((r) => r["code"])).not.toContain("SCR_KNOWLEDGE_UNAVAILABLE");

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).resolves.toMatchObject({ currentStatus: "PV1_APPROVED_READY_FOR_FILL" });
    });
  });

  it("still refuses when a REAL finding is outstanding, gaps notwithstanding", async () => {
    // The other half of the invariant, and the one that makes the
    // downgrade safe rather than a blanket weakening: the acknowledge
    // tier still works. A genuine MAJOR interaction gates the approval
    // exactly as before, and it is now the ONLY thing the pharmacist is
    // asked about — which is the entire point of clearing the noise.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    expect(outstandingFingerprints(fake)).toEqual([INTERACTION_FINGERPRINT]);

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        httpStatus: 422,
        metadata: expect.objectContaining({
          outstandingFindingCodes: ["SCR_DRUG_INTERACTION"],
        }),
      });
    });

    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("the gap is surfaced as a gap count on the screening event, not buried in a finding total", async () => {
    // A dashboard that cannot distinguish "screened, three findings"
    // from "could not screen" will report a fleet of successfully
    // screened prescriptions that were never screened at all.
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    const outbox = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    const screeningRow = rows.find((r) => r["eventType"] === "order.pv1.screening.recorded.v1");
    expect(screeningRow?.["payload"]).toMatchObject({
      outcome: "ADVISORY",
      // One unprovisioned knowledge source plus the one axis this
      // platform cannot supply. `gapCount` equals `findingCount` here,
      // which is the honest summary of an order on which nothing was
      // screened — and it stays visible in reporting even though
      // neither interrupted the pharmacist. THIS is where the systemic
      // deficiency has to be legible, because this is the number a
      // manager can act on.
      findingCount: 2,
      gapCount: 2,
      hardStopCount: 0,
      requiresAcknowledgementCount: 0,
      informationalCount: 2,
      phase: "PV1_START",
      minimumReportedSeverity: "MINOR",
      workflowPolicyVersion: 1,
    });
  });

  it("keeps counting the unsupplied axis as a gap once the knowledge-source mask lifts", async () => {
    // With a licensed source wired, the fleet-wide
    // SCR_KNOWLEDGE_UNAVAILABLE disappears. A dashboard reading
    // `gapCount` must not then see zero and conclude these orders
    // were fully screened.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    const rows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    const payload = rows.find((r) => r["eventType"] === "order.pv1.screening.recorded.v1")?.[
      "payload"
    ] as Record<string, unknown>;
    // One real interaction finding, plus the one axis that never ran.
    expect(payload["findingCount"]).toBe(2);
    expect(payload["gapCount"]).toBe(1);
  });

  it("still demands the click for a drug an otherwise-working database does not know", async () => {
    // The contrast that keeps the downgrade honest. A PROVISIONED
    // source that does not recognise ONE code is a fixable hole — check
    // the NDC, chase a reference-data update — so the pharmacist is
    // still asked, and the approval still refuses until they answer.
    //
    // Same finding code as the unprovisioned case, graded differently
    // because a different person can close it.
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({
      // Knows a drug, just not the one on this order.
      knowledgeSource: createInMemoryDrugKnowledgeSource({
        drugs: {
          SOME_OTHER_NDC: {
            ingredientCodes: ["INGREDIENT_ALFA"],
            uncodedIngredientCount: 0,
            therapeuticClassCodes: [],
            crossSensitivityClassCodes: [],
            doseRange: null,
          },
        },
      }),
    });

    await startReview();

    const outstanding = outstandingFingerprints(fake);
    expect(outstanding).toEqual([
      `SCR_KNOWLEDGE_UNAVAILABLE|MODERATE/DEFINITE|${CANDIDATE_NDC}|remediation=SUBJECT_DATA;scope=CANDIDATE_DRUG`,
    ]);

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });

    await acknowledge(PHARMACIST_A, outstanding, "ack");
    const approval = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-2" })
    );
    expect(approval.currentStatus).toBe("PV1_APPROVED_READY_FOR_FILL");
  });
});

// ---------------------------------------------------------------------------
// The hard stop
// ---------------------------------------------------------------------------

describe("PV1 screening — hard stop", () => {
  it("refuses approval with PV1_SCREENING_HARD_STOP and writes no verification record", async () => {
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithHardStopInteraction() });

    await startReview();

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_HARD_STOP",
        httpStatus: 422,
        metadata: expect.objectContaining({ findingCodes: ["SCR_DRUG_INTERACTION"] }),
      });
    });

    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(fake.currentStatus()).toBe("PV1_IN_PROGRESS");
  });

  it("cannot be acknowledged away", async () => {
    // A hard stop that could be acknowledged would not be a hard
    // stop; it would be an acknowledge-tier finding with extra steps.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithHardStopInteraction() });

    await startReview();

    const hardStopFingerprint =
      "SCR_DRUG_INTERACTION|CONTRAINDICATED/DEFINITE|INGREDIENT_ALFA+INGREDIENT_BRAVO";
    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(
          AcknowledgePV1ScreeningFinding,
          { orderId: ORDER_ID, fingerprint: hardStopFingerprint },
          { idempotencyKey: "ack-hard-stop" }
        )
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_FINDING_NOT_ACKNOWLEDGEABLE",
        httpStatus: 422,
      });
    });

    expect(callsOf(fake.calls, "orderScreeningAcknowledgement", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Acknowledgements belong to a person
// ---------------------------------------------------------------------------

describe("PV1 screening — acknowledgement is per pharmacist", () => {
  it("refuses when the outstanding finding was acknowledged by a DIFFERENT pharmacist", async () => {
    // The whole reason acknowledgements are keyed by pharmacist. If B's
    // judgement satisfied A's approval, A would sign a decision they
    // never made, and the acknowledgement would have become a
    // checkbox someone else already ticked.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    // B works through every outstanding finding.
    await acknowledge(PHARMACIST_B, outstandingFingerprints(fake), "ack-by-b");

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-by-a" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        metadata: expect.objectContaining({
          pharmacistUserId: PHARMACIST_A,
          outstandingFingerprints: expect.arrayContaining([INTERACTION_FINGERPRINT]),
        }),
      });
    });

    // B's acknowledgements are still on record — they just do not
    // travel to A.
    expect(fake.screening.state.acknowledgements.length).toBeGreaterThan(0);
    for (const acknowledgement of fake.screening.state.acknowledgements) {
      expect(acknowledgement.pharmacistUserId).toBe(PHARMACIST_B);
    }
  });

  it("passes once the approving pharmacist records their own", async () => {
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();
    const outstanding = outstandingFingerprints(fake);
    await acknowledge(PHARMACIST_B, outstanding, "ack-by-b");
    await acknowledge(PHARMACIST_A, outstanding, "ack-by-a");

    const approval = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-by-a" })
    );
    expect(approval.currentStatus).toBe("PV1_APPROVED_READY_FOR_FILL");
  });

  it("refuses a fingerprint no screen on this order ever produced", async () => {
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(
          AcknowledgePV1ScreeningFinding,
          { orderId: ORDER_ID, fingerprint: "SCR_MADE_UP|MAJOR/DEFINITE|WHATEVER" },
          { idempotencyKey: "ack-invented" }
        )
      ).rejects.toMatchObject({ code: "PV1_SCREENING_FINDING_UNKNOWN", httpStatus: 422 });
    });
    expect(callsOf(fake.calls, "orderScreeningAcknowledgement", "create")).toHaveLength(0);
  });

  it("refuses to record a judgement on an order that is no longer under review", async () => {
    const fake = buildFlowFake({ initialStatus: "PV1_APPROVED_READY_FOR_FILL" });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(
          AcknowledgePV1ScreeningFinding,
          { orderId: ORDER_ID, fingerprint: GAP_FINGERPRINT },
          { idempotencyKey: "ack-late" }
        )
      ).rejects.toMatchObject({ code: "PV1_SCREENING_STAGE_INVALID", httpStatus: 409 });
    });
  });

  it("a repeat acknowledgement is a no-op that emits no second event", async () => {
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();
    const first = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: INTERACTION_FINGERPRINT },
        { idempotencyKey: "ack-1" }
      )
    );
    // A DIFFERENT idempotency key, so the bus does not replay: this
    // exercises the row-level guard rather than the bus's cache.
    const second = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: INTERACTION_FINGERPRINT },
        { idempotencyKey: "ack-2" }
      )
    );

    expect(first.alreadyAcknowledged).toBe(false);
    expect(second.alreadyAcknowledged).toBe(true);
    expect(second.acknowledgementId).toBe(first.acknowledgementId);
    expect(callsOf(fake.calls, "orderScreeningAcknowledgement", "create")).toHaveLength(1);
    const acknowledgedEvents = callsOf(fake.calls, "orderEvent", "create").filter(
      (c) =>
        ((c.args as { data: Record<string, unknown> }).data["eventType"] as string) ===
        "order.pv1.screening.acknowledged.v1"
    );
    expect(acknowledgedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The reason ApprovePV1 re-screens
// ---------------------------------------------------------------------------

describe("PV1 screening — the profile moves during the review", () => {
  it("a medication added between StartPV1 and ApprovePV1 produces a new finding that blocks", async () => {
    // This is the case the re-screen exists for. At StartPV1 the
    // patient is on nothing else and the screen is genuinely clear.
    // While the pharmacist reads the order, a clinic adds an
    // interacting medication to the profile. Gating on the start-time
    // snapshot would approve against a world that no longer exists.
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    // Clear on the CLINICAL axes at start: the candidate is known,
    // nothing else is on the profile, and the patient's allergy history
    // was taken and found empty — so interaction, duplication and
    // allergy all ran and found nothing. The one unsupported axis
    // records itself, as it does on every screen, and it is not
    // outstanding — so the pharmacist begins with nothing to click.
    const startFindings = callsOf(fake.calls, "orderScreeningFinding", "createMany").flatMap(
      (c) => (c.args as { data: Array<Record<string, unknown>> }).data
    );
    expect(startFindings.map((r) => r["code"]).sort()).toEqual(["SCR_DOSE_INPUT_UNAVAILABLE"]);
    expect(outstandingFingerprints(fake)).toEqual([]);

    // …and now the profile gains an interacting drug.
    fake.screening.state.prescriptions.push({
      id: PROFILE_RX,
      patientId: PATIENT_ID,
      drugNdc: PROFILE_NDC,
      status: "ACTIVE",
      drugName: "PLACEHOLDER-PROFILE-NAME",
    });

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        // Exactly the interaction, and nothing else. The platform gaps
        // never demanded a decision, so what is outstanding at sign-off
        // is precisely what changed under the review — which is the
        // signal the pharmacist needs to see and the reason the noise
        // was cleared out from under it.
        metadata: expect.objectContaining({
          outstandingFindingCodes: ["SCR_DRUG_INTERACTION"],
        }),
      });
    });
  });

  it("an acknowledgement given at start does not carry to a finding whose grading changed", async () => {
    // Severity and certainty are part of the fingerprint, so an
    // upgraded interaction is a DIFFERENT situation and has to be
    // asked about again. Without this, a knowledge-source update that
    // promotes MAJOR to CONTRAINDICATED would be silently swallowed by
    // an acknowledgement given against the weaker claim.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();
    await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: INTERACTION_FINGERPRINT },
        { idempotencyKey: "ack" }
      )
    );

    // The vendor upgrades the grading between review and sign-off.
    configureClinicalScreening({ knowledgeSource: knowledgeWithHardStopInteraction() });

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });
    });
  });
});

// ---------------------------------------------------------------------------
// A refusal has to leave its own evidence behind
// ---------------------------------------------------------------------------

describe("PV1 screening — a finding raised for the first time at sign-off", () => {
  /**
   * The candidate is known; the drug that lands on the profile
   * mid-review is not.
   *
   * That combination is what makes this reachable with no licensed
   * knowledge source, no allergy capture and no structured sig: the
   * profile-medication knowledge gap is only raised when the
   * CANDIDATE is known (an unknown candidate gaps the whole screen and
   * says everything already), and the gap's fingerprint carries the
   * drug code, so a drug the pharmacist has never seen produces a
   * fingerprint no acknowledgement of theirs can match.
   */
  function knowledgeWithCandidateOnly(): DrugKnowledgeSource {
    return createInMemoryDrugKnowledgeSource({
      drugs: {
        [CANDIDATE_NDC]: {
          ingredientCodes: ["INGREDIENT_ALFA"],
          uncodedIngredientCount: 0,
          therapeuticClassCodes: [],
          crossSensitivityClassCodes: [],
          doseRange: null,
        },
      },
    });
  }

  /** A second order for the same patient goes ACTIVE mid-review. */
  const SECOND_ORDER_RX = "00000000-0000-4000-8000-0000000000e3";
  const SECOND_ORDER_NDC = "00000-0000-03";
  // MODERATE, and therefore outstanding: this source IS provisioned —
  // it knows the candidate — so one code it does not hold is a fixable
  // hole somebody can chase, not a systemic absence.
  const PROFILE_GAP_FINGERPRINT = `SCR_KNOWLEDGE_UNAVAILABLE|MODERATE/DEFINITE|${SECOND_ORDER_NDC}|remediation=SUBJECT_DATA;scope=PROFILE_MEDICATION`;

  /**
   * The rows the console would render: the newest screen, grouped by
   * the command that produced it, exactly as `getOrderScreening` does.
   *
   * "Newest" is insertion order here rather than `occurredAt`, because
   * the bus runs on a frozen clock in these suites and every screen
   * stamps the same instant. The console's second sort key
   * (`createdAt desc`) is what breaks that tie in Postgres; insertion
   * order is its analogue in the fake.
   */
  function latestScreen(fake: FlowFake): ReadonlyArray<StubFinding> {
    const rows = fake.screening.state.persistedFindings;
    const newest = rows.at(-1);
    if (newest === undefined) return [];
    return rows.filter((row) => row.commandLogId === newest.commandLogId);
  }

  it("refuses, records the screen it refused against, and lets the pharmacist acknowledge and approve", async () => {
    // The whole contract, in one test. Before this, step 3 refused and
    // rolled the screen back with it: the panel kept showing the
    // start-time findings with nothing outstanding, the acknowledge
    // command refused the new fingerprint as one it had never seen,
    // and re-approving produced the identical refusal forever. The
    // only exit was rejecting a clinically fine prescription.
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithCandidateOnly() });

    // 1 + 2. The pharmacist opens the review. Everything the screen
    // puts in front of them is a gap nobody in the pharmacy can close,
    // so there is nothing outstanding to work through.
    await startReview();
    expect(outstandingFingerprints(fake)).toEqual([]);

    // 3. The patient's OTHER order progresses and its drug lands on
    // the profile. Nobody touched this order.
    fake.screening.state.prescriptions.push({
      id: SECOND_ORDER_RX,
      patientId: PATIENT_ID,
      drugNdc: SECOND_ORDER_NDC,
      status: "ACTIVE",
      drugName: "PLACEHOLDER-SECOND-ORDER-NAME",
    });

    // 4. Sign-off re-screens and refuses on a finding that did not
    // exist when the pharmacist started.
    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        httpStatus: 422,
        metadata: expect.objectContaining({
          outstandingFingerprints: [PROFILE_GAP_FINGERPRINT],
        }),
      });
    });

    // The refusal refused: no approval, no transition.
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(fake.currentStatus()).toBe("PV1_IN_PROGRESS");

    // 5. …and it left its evidence. The screen the gate judged is on
    // record, as the newest screen, which is the one the console
    // renders — so the panel shows EXACTLY what refused the approval
    // rather than a stale set with nothing outstanding.
    const shown = latestScreen(fake);
    expect(shown.map((row) => row.fingerprint).sort()).toEqual(
      [...UNSUPPLIED_AXIS_FINGERPRINTS, PROFILE_GAP_FINGERPRINT].sort()
    );
    for (const row of shown) {
      expect(row.phase).toBe("PV1_APPROVE");
    }

    // 6. The new finding can be acknowledged, because it was actually
    // persisted — the command refuses any fingerprint that was not.
    const acknowledgement = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: PROFILE_GAP_FINGERPRINT },
        { idempotencyKey: "ack-profile-gap" }
      )
    );
    expect(acknowledgement.alreadyAcknowledged).toBe(false);

    // 7. And the second attempt goes through. Note the SAME
    // idempotency key as the refused attempt: a refusal writes no
    // idempotency row, so the retry re-executes instead of replaying
    // the refusal it was sent to resolve.
    const approval = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
    );
    expect(approval.currentStatus).toBe("PV1_APPROVED_READY_FOR_FILL");
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);
  });

  it("records a hard stop raised at sign-off too, so the pharmacist can read what blocked them", async () => {
    // A hard stop has no acknowledgement path, but it has a reason, a
    // grading and a citation the pharmacist has to quote to the
    // prescriber. Rolling those back leaves them with a code in a
    // banner and a panel that disagrees with it.
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();
    await acknowledge(PHARMACIST_A, outstandingFingerprints(fake), "ack-start");

    // The interacting drug appears on the profile, and the vendor
    // grades the pair CONTRAINDICATED / DEFINITE.
    fake.screening.state.prescriptions.push({
      id: PROFILE_RX,
      patientId: PATIENT_ID,
      drugNdc: PROFILE_NDC,
      status: "ACTIVE",
      drugName: "PLACEHOLDER-PROFILE-NAME",
    });
    configureClinicalScreening({ knowledgeSource: knowledgeWithHardStopInteraction() });

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });
    });

    expect(latestScreen(fake).map((row) => row.code)).toContain("SCR_DRUG_INTERACTION");
    expect(fake.currentStatus()).toBe("PV1_IN_PROGRESS");
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
  });

  it("puts the refused attempt on the order timeline and in the audit log, without a version bump", async () => {
    // A refusal that commits has to say what it was. Two events: the
    // screen (the same event a successful approval emits, so a
    // consumer counting screens counts this one) and the verdict.
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithCandidateOnly() });

    await startReview();
    const eventsBefore = callsOf(fake.calls, "orderEvent", "create").length;
    const casBefore = callsOf(fake.calls, "order", "updateMany").length;

    // The patient's other order goes ACTIVE mid-review, carrying a drug
    // this provisioned source does not hold — an outstanding finding
    // that did not exist when the pharmacist opened the review, which
    // is what gives the sign-off something to refuse on.
    fake.screening.state.prescriptions.push({
      id: SECOND_ORDER_RX,
      patientId: PATIENT_ID,
      drugNdc: SECOND_ORDER_NDC,
      status: "ACTIVE",
      drugName: "PLACEHOLDER-SECOND-ORDER-NAME",
    });

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });

    const newEvents = callsOf(fake.calls, "orderEvent", "create")
      .slice(eventsBefore)
      .map((c) => (c.args as { data: Record<string, unknown> }).data["eventType"]);
    expect(newEvents).toEqual(["order.pv1.screening.recorded.v1", "order.pv1.approval.refused.v1"]);

    const audit = callsOf(fake.calls, "auditLog", "create").at(-1)!.args as {
      data: Record<string, unknown>;
    };
    expect(audit.data["action"]).toBe("order.pv1.approval.refused_by_screening");
    expect(audit.data["metadata"]).toMatchObject({
      refusalCode: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
      currentStatus: "PV1_IN_PROGRESS",
    });

    // Nothing transitioned, so nothing moved the order's version and
    // no concurrent command's CAS was invalidated on behalf of an act
    // that did not happen.
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(casBefore);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1); // StartPV1's only
  });
});

// ---------------------------------------------------------------------------
// Idempotency + concurrency
// ---------------------------------------------------------------------------

describe("PV1 screening — replay and concurrency", () => {
  it("replaying an approval with the same idempotency key does not re-screen or re-record", async () => {
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    await acknowledge(PHARMACIST_A, outstandingFingerprints(fake), "ack");

    const first = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-once" })
    );
    const replay = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-once" })
    );

    expect(replay).toEqual(first);
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(1);
    // One PV1_APPROVE screening pass, not two. A replay that
    // re-screened could reach a DIFFERENT answer than the one it is
    // replaying, which is the opposite of what a replay means.
    const approvePhaseWrites = callsOf(fake.calls, "orderScreeningFinding", "createMany").filter(
      (c) =>
        ((c.args as { data: Array<Record<string, unknown>> }).data[0]?.["phase"] as string) ===
        "PV1_APPROVE"
    );
    expect(approvePhaseWrites).toHaveLength(1);
  });

  it("two concurrent approvals of one order: exactly one wins", async () => {
    // Both attempts pass the screening gate — they see the same
    // findings and the same acknowledgements — so the thing that has
    // to hold is the version CAS underneath. Exactly one approval
    // may land; the loser must not leave a second verification
    // record or a second state transition behind.
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    const acknowledged = outstandingFingerprints(fake);
    await acknowledge(PHARMACIST_A, acknowledged, "ack");

    const results = await Promise.allSettled([
      withTenancyContext(ctxFor(PHARMACIST_A), () =>
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-1" })
      ),
      withTenancyContext(ctxFor(PHARMACIST_A), () =>
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-2" })
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "ORDER_VERSION_MISMATCH",
    });
    // The loser's tx rolls back in production; here we assert the
    // observable consequence — only the winner reached the bus's
    // post-CAS writes. StartPV1 contributes its transition and its
    // screening record, each acknowledgement one, and the winning
    // approval its transition and screening record. The loser
    // contributes none.
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(2 + acknowledged.length + 2);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1 + acknowledged.length + 1);
    // Both attempts DID reach `verificationRecord.create` inside their
    // own transaction — the loser's rolls back in Postgres, and the
    // fake records calls regardless of tx outcome (same convention as
    // the CAS test in approve-pv1.test.ts). What proves the race was
    // resolved is that only one attempt got past the CAS into the
    // bus's post-transaction writes, asserted above.
    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PHI
// ---------------------------------------------------------------------------

describe("PV1 screening — PHI invariant", () => {
  it("no persisted row and no event payload carries a patient identifier or a drug name", async () => {
    // The engine is designed so a finding is safe to persist verbatim,
    // but "designed so" is not "verified so" — this pins it over the
    // actual writes the three commands make, including the audit and
    // outbox surfaces that fan out furthest.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();
    await acknowledge(PHARMACIST_A, outstandingFingerprints(fake), "ack");
    await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
    );

    // Every write that survives the transaction, in one bag.
    const persistedWrites = fake.calls.filter(
      (c) =>
        (c.table === "orderScreeningFinding" && c.op === "createMany") ||
        (c.table === "orderScreeningAcknowledgement" && c.op === "create") ||
        (c.table === "orderEvent" && c.op === "create") ||
        (c.table === "auditLog" && c.op === "create") ||
        (c.table === "eventOutbox" && c.op === "createMany") ||
        (c.table === "verificationRecord" && c.op === "create")
    );
    expect(persistedWrites.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(
      persistedWrites.map((c) => c.args),
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    );

    // The patient. Nothing downstream of screening needs to know
    // which patient this was — the order id is the handle.
    expect(serialized).not.toContain(PATIENT_ID);
    // The drug, by name. Codes are fine and are the whole vocabulary;
    // a name is what turns a finding row into a clinical disclosure.
    expect(serialized).not.toContain(CANDIDATE_DRUG_NAME);
    expect(serialized).not.toContain("PLACEHOLDER-PROFILE-NAME");
    // Belt and braces against the usual PHI column names arriving via
    // a widened select.
    expect(serialized).not.toMatch(/firstName|lastName|dateOfBirth|drugName|\bsig\b/i);

    // …and the codes ARE there, so the assertions above are not
    // passing because nothing was written.
    expect(serialized).toContain("SCR_DRUG_INTERACTION");
    expect(serialized).toContain("INGREDIENT_ALFA");
  });
});

// ---------------------------------------------------------------------------
// Knowledge-release attribution and the per-screen resolver
// ---------------------------------------------------------------------------

describe("PV1 screening — knowledge-release attribution", () => {
  it("stamps the source's release onto every persisted finding row", async () => {
    // The same treatment `workflowPolicyId`/`Version` get: the
    // reference data moves under the findings on every ingestion, so
    // "why did this not fire in March?" needs each row to name the
    // release it was screened against.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({
      knowledgeSource: createInMemoryDrugKnowledgeSource({
        drugs: {
          [CANDIDATE_NDC]: {
            ingredientCodes: ["INGREDIENT_ALFA"],
            uncodedIngredientCount: 0,
            therapeuticClassCodes: [],
            crossSensitivityClassCodes: [],
            doseRange: null,
          },
          [PROFILE_NDC]: {
            ingredientCodes: ["INGREDIENT_BRAVO"],
            uncodedIngredientCount: 0,
            therapeuticClassCodes: [],
            crossSensitivityClassCodes: [],
            doseRange: null,
          },
        },
        interactions: [
          {
            ingredients: ["INGREDIENT_ALFA", "INGREDIENT_BRAVO"],
            fact: { severity: "MAJOR", certainty: "PROBABLE", citation: null },
          },
        ],
        release: { source: "TEST_KNOWLEDGE_SOURCE", version: "0101" },
      }),
    });

    await startReview();

    const rows = fake.screening.state.persistedFindings;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.knowledgeSourceCode).toBe("TEST_KNOWLEDGE_SOURCE");
      expect(row.knowledgeReleaseVersion).toBe("0101");
    }
  });

  it("stamps NULL for a source with no release identity — the honest answer, not a bug", async () => {
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    const rows = fake.screening.state.persistedFindings;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.knowledgeSourceCode).toBeNull();
      expect(row.knowledgeReleaseVersion).toBeNull();
    }
  });
});

describe("PV1 screening — remediation is persisted on the row", () => {
  it("persists the engine's remediation on every gap row and NULL on every clinical row", async () => {
    // The column exists so coverage reporting can GROUP BY remediation
    // without re-deriving "whose fault" from severity. That is only
    // safe if the write path stamps every gap and never a clinical
    // finding — the same invariant the migration CHECK holds in the
    // forbidding direction.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({
      knowledgeSource: createInMemoryDrugKnowledgeSource({
        drugs: {
          [CANDIDATE_NDC]: {
            ingredientCodes: ["INGREDIENT_ALFA"],
            uncodedIngredientCount: 0,
            therapeuticClassCodes: [],
            crossSensitivityClassCodes: [],
            doseRange: null,
          },
          [PROFILE_NDC]: {
            ingredientCodes: ["INGREDIENT_BRAVO"],
            uncodedIngredientCount: 0,
            therapeuticClassCodes: [],
            crossSensitivityClassCodes: [],
            doseRange: null,
          },
        },
        interactions: [
          {
            ingredients: ["INGREDIENT_ALFA", "INGREDIENT_BRAVO"],
            fact: { severity: "MAJOR", certainty: "PROBABLE", citation: null },
          },
        ],
      }),
    });

    await startReview();

    const rows = fake.screening.state.persistedFindings;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.remediation !== null, row.code).toBe(row.kind === "SCREENING_GAP");
    }

    const interaction = rows.find((row) => row.code === "SCR_DRUG_INTERACTION");
    expect(interaction?.remediation).toBeNull();

    // Every stub prescription is a legacy transcription (no structured
    // sig) and prescriptions are immutable, so the dose gap carries the
    // one remediation severity recovery could never express — which is
    // exactly the row the column was added for.
    const doseGap = rows.find((row) => row.code === "SCR_DOSE_INPUT_UNAVAILABLE");
    expect(doseGap?.remediation).toBe("RECORD_IMMUTABLE");
  });

  it("persists PLATFORM_CAPABILITY on the unprovisioned-knowledge gap", async () => {
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    const gap = fake.screening.state.persistedFindings.find(
      (row) => row.code === "SCR_KNOWLEDGE_UNAVAILABLE"
    );
    expect(gap?.remediation).toBe("PLATFORM_CAPABILITY");
  });
});

describe("PV1 screening — the per-screen knowledge source resolver", () => {
  it("receives the screen's own transaction and drug codes, and its source decides the screen", async () => {
    // The production shape: a database-backed adapter prefetches
    // exactly the codes the engine will ask about, inside the
    // command's transaction. Pinned here with a resolver that records
    // its context and hands back a seeded source, so the wiring — not
    // just the adapter — is under test.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);

    const seenContexts: Array<{ organizationId: string; drugCodes: ReadonlyArray<string> }> = [];
    configureClinicalScreening({
      knowledgeSourceResolver: async (context) => {
        expect(context.tx).toBeDefined();
        seenContexts.push({
          organizationId: context.organizationId,
          drugCodes: context.drugCodes,
        });
        return knowledgeWithAcknowledgeTierInteraction();
      },
    });

    await startReview();

    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]?.organizationId).toBe(ORG_ID);
    expect([...(seenContexts[0]?.drugCodes ?? [])].sort()).toEqual(
      [CANDIDATE_NDC, PROFILE_NDC].sort()
    );

    // The resolver's source is what screened: the seeded interaction
    // is on the record.
    expect(fake.screening.state.persistedFindings.map((f) => f.code)).toContain(
      "SCR_DRUG_INTERACTION"
    );
  });
});

// ---------------------------------------------------------------------------
// Patient-scoped acknowledgement of the allergy-history gap
// ---------------------------------------------------------------------------

describe("PV1 screening — the allergy-history gap is acknowledged per PATIENT", () => {
  // The scoping split, the re-arm sequence, per-pharmacist
  // independence, the backward-compatibility path and the structural
  // guarantee, all through the real commands — because every one of
  // these properties is a statement about what ApprovePV1's gate does
  // with persisted rows, not about any classifier in isolation.

  /** A patient nobody has asked, which is what raises the gap. */
  const patientNobodyAsked: ScreeningStubOptions = { ...candidateOnly, historyAssertions: [] };

  /** The current allergy record-state token, against the fake's rows. */
  function currentAllergyToken(fake: FlowFake): Promise<string> {
    const tx = {
      patientAllergy: fake.screening.patientAllergy,
      patientAllergyHistoryAssertion: fake.screening.patientAllergyHistoryAssertion,
    } as unknown as TenantTransactionClient;
    return patientRecordStateToken(
      { tx, organizationId: ORG_ID, patientId: PATIENT_ID },
      "DRUG_ALLERGY"
    );
  }

  function approveAs(pharmacistUserId: string, key: string) {
    return withTenancyContext(ctxFor(pharmacistUserId), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: key })
    );
  }

  it("acknowledging the gap files it against the PATIENT, and the approval passes", async () => {
    const fake = buildFlowFake({ screening: patientNobodyAsked });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    await expect(approveAs(PHARMACIST_A, "approve-unacked")).rejects.toMatchObject({
      code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
    });

    const result = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT },
        { idempotencyKey: "ack-patient-gap" }
      )
    );
    expect(result.scope).toBe("PATIENT");
    expect(result.alreadyAcknowledged).toBe(false);

    // Filed in the PATIENT table, stamped with axis and token — and
    // NOT in the order table: one judgement, one home.
    expect(fake.screening.state.patientAcknowledgements).toHaveLength(1);
    expect(fake.screening.state.patientAcknowledgements[0]).toMatchObject({
      patientId: PATIENT_ID,
      pharmacistUserId: PHARMACIST_A,
      axis: "DRUG_ALLERGY",
      fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT,
      recordStateToken: await currentAllergyToken(fake),
    });
    expect(fake.screening.state.acknowledgements).toHaveLength(0);

    // Its own event type, so reporting can tell the scopes apart.
    const eventTypes = callsOf(fake.calls, "orderEvent", "create").map(
      (c) => (c.args as { data: Record<string, unknown> }).data["eventType"]
    );
    expect(eventTypes).toContain("order.pv1.screening.acknowledged_for_patient.v1");
    expect(eventTypes).not.toContain("order.pv1.screening.acknowledged.v1");

    await expect(approveAs(PHARMACIST_A, "approve-acked")).resolves.toMatchObject({
      currentStatus: "PV1_APPROVED_READY_FOR_FILL",
    });
  });

  it("a patient-scoped acknowledgement recorded on an EARLIER order covers this one", async () => {
    // Refill twelve. The pharmacist acknowledged "no allergy history
    // recorded" on a previous order for this patient; the record has
    // not changed; this order must not charge them again.
    const fake = buildFlowFake({ screening: patientNobodyAsked });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    fake.screening.state.patientAcknowledgements.push({
      id: "prior-order-ack",
      patientId: PATIENT_ID,
      // A different order entirely — the key is the patient.
      orderId: "00000000-0000-4000-8000-00000000feed",
      pharmacistUserId: PHARMACIST_A,
      axis: "DRUG_ALLERGY",
      fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT,
      recordStateToken: await currentAllergyToken(fake),
    });

    await startReview();
    // The gap is still SCREENED and PERSISTED — coverage suppresses
    // the re-prompt, never the record.
    expect(outstandingFingerprints(fake)).toEqual([ALLERGY_NOT_RECORDED_FINGERPRINT]);

    await expect(approveAs(PHARMACIST_A, "approve-covered")).resolves.toMatchObject({
      currentStatus: "PV1_APPROVED_READY_FOR_FILL",
    });
    // No acknowledgement of any scope was recorded on THIS order.
    expect(fake.screening.state.acknowledgements).toHaveLength(0);
    expect(fake.screening.state.patientAcknowledgements).toHaveLength(1);
  });

  it("a COLLEAGUE's patient-scoped acknowledgement opens nothing", async () => {
    const fake = buildFlowFake({ screening: patientNobodyAsked });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    fake.screening.state.patientAcknowledgements.push({
      id: "colleague-ack",
      patientId: PATIENT_ID,
      orderId: "00000000-0000-4000-8000-00000000feed",
      pharmacistUserId: PHARMACIST_B,
      axis: "DRUG_ALLERGY",
      fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT,
      recordStateToken: await currentAllergyToken(fake),
    });

    await startReview();
    await expect(approveAs(PHARMACIST_A, "approve-colleague")).rejects.toMatchObject({
      code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
      metadata: expect.objectContaining({
        outstandingFingerprints: expect.arrayContaining([ALLERGY_NOT_RECORDED_FINGERPRINT]),
      }),
    });
  });

  it("RE-ARMS: allergy data recorded and then entered-in-error re-prompts despite the old acknowledgement", async () => {
    // The dangerous sequence, end to end. Gap acknowledged → a
    // technician records an allergy (gap resolves) → the record is
    // retracted as entered-in-error (gap re-arises, SAME fingerprint).
    // The acknowledgement was given about a record that no longer
    // exists in that state; honoring it now would let a years-old
    // click suppress the one situation that deserves fresh eyes.
    const fake = buildFlowFake({ screening: patientNobodyAsked });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    const first = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT },
        { idempotencyKey: "ack-original" }
      )
    );
    expect(first.scope).toBe("PATIENT");

    // A history is taken and an allergy recorded…
    fake.screening.state.allergies.push(
      screenableStubAllergy({ patientId: PATIENT_ID, id: "00000000-0000-4000-8000-00000000a0e1" })
    );
    // …and later retracted as entered-in-error. The ROW REMAINS —
    // retraction is a status amendment — which is exactly why the
    // record-state token cannot travel back to its pre-record value.
    fake.screening.state.allergies[0] = {
      ...fake.screening.state.allergies[0]!,
      verificationStatus: "ENTERED_IN_ERROR",
      statusChangedAt: new Date("2026-08-07T13:00:00.000Z"),
    };

    // The gap re-arises with the SAME fingerprint, and the old
    // acknowledgement does NOT cover it.
    await expect(approveAs(PHARMACIST_A, "approve-rearmed")).rejects.toMatchObject({
      code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
      metadata: expect.objectContaining({
        outstandingFingerprints: expect.arrayContaining([ALLERGY_NOT_RECORDED_FINGERPRINT]),
      }),
    });

    // A fresh judgement is a NEW row — the table is append-only, and
    // "same fingerprint, different record state" is a different act.
    const second = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT },
        { idempotencyKey: "ack-fresh" }
      )
    );
    expect(second.scope).toBe("PATIENT");
    expect(second.alreadyAcknowledged).toBe(false);
    expect(second.acknowledgementId).not.toBe(first.acknowledgementId);
    expect(fake.screening.state.patientAcknowledgements).toHaveLength(2);

    await expect(approveAs(PHARMACIST_A, "approve-fresh")).resolves.toMatchObject({
      currentStatus: "PV1_APPROVED_READY_FOR_FILL",
    });
  });

  it("BACKWARD COMPAT: an order-scoped acknowledgement recorded before patient scoping still satisfies ITS order", async () => {
    // Rows written by the pre-patient-scope build live in
    // `order_screening_acknowledgement` with this same fingerprint.
    // They were legitimate judgements; the gate honors them on the
    // order they were recorded on, and nothing invalidates them.
    const fake = buildFlowFake({ screening: patientNobodyAsked });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    fake.screening.state.acknowledgements.push({
      id: "legacy-order-ack",
      orderId: ORDER_ID,
      pharmacistUserId: PHARMACIST_A,
      fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT,
    });

    await startReview();
    await expect(approveAs(PHARMACIST_A, "approve-legacy")).resolves.toMatchObject({
      currentStatus: "PV1_APPROVED_READY_FOR_FILL",
    });
    // The legacy row carried the approval; no patient-scoped row was
    // needed or written.
    expect(fake.screening.state.patientAcknowledgements).toHaveLength(0);
  });

  it("STRUCTURAL: a patient-table row matching a CLINICAL finding's fingerprint opens nothing", async () => {
    // The hand-mutation proof, at runtime. The database's CHECK
    // constraints refuse such a row (pinned in the integration
    // suite); this test plants one anyway — as if written by a bugged
    // or malicious writer — and proves the gate still refuses,
    // because the patient-scoped lookup is only ever consulted for
    // findings `asPatientRecordGap` accepted. Suppressing a
    // drug-interaction alert patient-wide must take more than a row.
    const fake = buildFlowFake({ screening: candidateAndInteractingProfileDrug });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    fake.screening.state.patientAcknowledgements.push({
      id: "forged-clinical-ack",
      patientId: PATIENT_ID,
      orderId: ORDER_ID,
      pharmacistUserId: PHARMACIST_A,
      axis: "DRUG_ALLERGY",
      fingerprint: INTERACTION_FINGERPRINT,
      recordStateToken: await currentAllergyToken(fake),
    });

    await startReview();
    await expect(approveAs(PHARMACIST_A, "approve-forged")).rejects.toMatchObject({
      code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
      metadata: expect.objectContaining({
        outstandingFingerprints: expect.arrayContaining([INTERACTION_FINGERPRINT]),
      }),
    });

    // And acknowledging the interaction through the command files it
    // against the ORDER — the classifier, not the caller, owns scope.
    const acknowledged = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: INTERACTION_FINGERPRINT },
        { idempotencyKey: "ack-interaction" }
      )
    );
    expect(acknowledged.scope).toBe("ORDER");
  });

  it("a repeat patient-scoped acknowledgement at an unchanged record state is a no-op", async () => {
    const fake = buildFlowFake({ screening: patientNobodyAsked });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    const first = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT },
        { idempotencyKey: "ack-p-1" }
      )
    );
    // A DIFFERENT idempotency key: this exercises the row-level
    // guard, not the bus's replay cache.
    const second = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: ALLERGY_NOT_RECORDED_FINGERPRINT },
        { idempotencyKey: "ack-p-2" }
      )
    );
    expect(first.alreadyAcknowledged).toBe(false);
    expect(second.alreadyAcknowledged).toBe(true);
    expect(second.acknowledgementId).toBe(first.acknowledgementId);
    expect(callsOf(fake.calls, "patientScreeningAcknowledgement", "create")).toHaveLength(1);
    const events = callsOf(fake.calls, "orderEvent", "create").filter(
      (c) =>
        ((c.args as { data: Record<string, unknown> }).data["eventType"] as string) ===
        "order.pv1.screening.acknowledged_for_patient.v1"
    );
    expect(events).toHaveLength(1);
  });
});
