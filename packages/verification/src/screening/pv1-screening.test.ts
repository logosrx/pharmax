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

import { AcknowledgePV1ScreeningFinding } from "../commands/acknowledge-pv1-screening-finding.js";
import { ApprovePV1 } from "../commands/approve-pv1.js";
import { StartPV1 } from "../commands/start-pv1.js";

import {
  configureClinicalScreening,
  resetClinicalScreeningConfigurationForTests,
} from "./configure.js";
import {
  createScreeningStubs,
  type ScreeningStubOptions,
  type ScreeningStubs,
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
const GAP_FINGERPRINT = `SCR_KNOWLEDGE_UNAVAILABLE|MODERATE/DEFINITE|${CANDIDATE_NDC}|scope=CANDIDATE_DRUG`;
const INTERACTION_FINGERPRINT =
  "SCR_DRUG_INTERACTION|MAJOR/PROBABLE|INGREDIENT_ALFA+INGREDIENT_BRAVO";

/**
 * The two axes this platform cannot supply at all: there is no
 * allergy capture, and the sig is encrypted free text with no
 * structured dose beside it. `run-screen.ts` declares both
 * UNAVAILABLE, so every screen reports them — including the screens
 * below where the knowledge source knows the drugs perfectly well.
 *
 * Neither fingerprint carries a drug code: the fact is about the
 * platform, not the prescription, so one acknowledgement settles it
 * for the whole order however many lines it has.
 */
const ALLERGY_INPUT_GAP_FINGERPRINT =
  "SCR_ALLERGY_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DRUG_ALLERGY";
const DOSE_INPUT_GAP_FINGERPRINT = "SCR_DOSE_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DOSE_RANGE";
const UNSUPPLIED_AXIS_FINGERPRINTS: ReadonlyArray<string> = [
  ALLERGY_INPUT_GAP_FINGERPRINT,
  DOSE_INPUT_GAP_FINGERPRINT,
];

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
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: null,
      },
      [PROFILE_NDC]: {
        ingredientCodes: ["INGREDIENT_BRAVO"],
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
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: null,
      },
      [PROFILE_NDC]: {
        ingredientCodes: ["INGREDIENT_BRAVO"],
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
// The empty knowledge source — the shipped default
// ---------------------------------------------------------------------------

describe("PV1 screening — with no drug knowledge configured", () => {
  it("reports a gap rather than a clear screen, and the gap blocks approval until acknowledged", async () => {
    // The single most important behaviour in this feature. Pharmax
    // ships no drug data, so out of the box the engine can answer
    // none of its questions. It must say that — loudly enough to stop
    // an approval — rather than return "no findings", which a
    // pharmacist reads as "clinically clear".
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();

    const persisted = callsOf(fake.calls, "orderScreeningFinding", "createMany");
    expect(persisted).toHaveLength(1);
    const rows = (persisted[0]!.args as { data: Array<Record<string, unknown>> }).data;
    // Three separate things could not be checked, and each is its own
    // fact with its own owner: the knowledge source does not know
    // this NDC (a licensed-data problem), and this platform can
    // supply neither an allergy list nor a structured dose (two
    // product gaps).
    expect(rows.map((r) => r["fingerprint"])).toEqual(
      expect.arrayContaining([
        GAP_FINGERPRINT,
        ALLERGY_INPUT_GAP_FINGERPRINT,
        DOSE_INPUT_GAP_FINGERPRINT,
      ])
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "SCREENING_GAP",
        disposition: "REQUIRES_ACKNOWLEDGEMENT",
        phase: "PV1_START",
      });
    }

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        httpStatus: 422,
        metadata: expect.objectContaining({
          outstandingFindingCodes: expect.arrayContaining([
            "SCR_KNOWLEDGE_UNAVAILABLE",
            "SCR_ALLERGY_INPUT_UNAVAILABLE",
            "SCR_DOSE_INPUT_UNAVAILABLE",
          ]),
        }),
      });
    });

    expect(callsOf(fake.calls, "verificationRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1); // StartPV1's only
  });

  it("reports the two axes this platform cannot supply even when the drug IS known", async () => {
    // The regression that motivated the input-availability
    // declaration. Wiring a licensed knowledge source silences
    // SCR_KNOWLEDGE_UNAVAILABLE and makes interaction and duplication
    // screen for real — and, before this, a prescription would then
    // come back CLEAR having never been compared against an allergy
    // list that does not exist. Allergy is the only axis that can
    // produce a hard stop, so it was the axis most capable of saving
    // someone that was silently not running.
    const fake = buildFlowFake({ screening: candidateOnly });
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: knowledgeWithAcknowledgeTierInteraction() });

    await startReview();

    const rows = callsOf(fake.calls, "orderScreeningFinding", "createMany").flatMap(
      (c) => (c.args as { data: Array<Record<string, unknown>> }).data
    );
    expect(rows.map((r) => r["code"])).toEqual(
      expect.arrayContaining(["SCR_ALLERGY_INPUT_UNAVAILABLE", "SCR_DOSE_INPUT_UNAVAILABLE"])
    );
    // Nothing pretends the drug is unknown — it is not.
    expect(rows.map((r) => r["code"])).not.toContain("SCR_KNOWLEDGE_UNAVAILABLE");

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
      ).rejects.toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
    });
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
      // One unrecognised drug plus the two axes this platform cannot
      // supply. `gapCount` equals `findingCount` here, which is the
      // honest summary of an order on which nothing was screened.
      findingCount: 3,
      gapCount: 3,
      hardStopCount: 0,
      requiresAcknowledgementCount: 3,
      phase: "PV1_START",
      minimumReportedSeverity: "MINOR",
      workflowPolicyVersion: 1,
    });
  });

  it("keeps counting the unsupplied axes as gaps once the knowledge-source mask lifts", async () => {
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
    // One real interaction finding, plus two axes that never ran.
    expect(payload["findingCount"]).toBe(3);
    expect(payload["gapCount"]).toBe(2);
  });

  it("approves once the pharmacist has acknowledged that the screen could not run", async () => {
    // Approving an unscreened prescription is allowed — refusing
    // would make our missing reference data the patient's problem —
    // but only against a recorded acknowledgement that says so.
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    await acknowledge(PHARMACIST_A, outstandingFingerprints(fake), "ack");
    const approval = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve" })
    );

    expect(approval.currentStatus).toBe("PV1_APPROVED_READY_FOR_FILL");
    // And the approval recorded WHAT it was approved against — with
    // each gap still graded REQUIRES_ACKNOWLEDGEMENT rather than
    // softened to informational because it had been acknowledged.
    const approvePhaseRows = callsOf(fake.calls, "orderScreeningFinding", "createMany")
      .flatMap((c) => (c.args as { data: Array<Record<string, unknown>> }).data)
      .filter((r) => r["phase"] === "PV1_APPROVE");
    expect(approvePhaseRows.map((r) => r["code"])).toEqual(
      expect.arrayContaining([
        "SCR_KNOWLEDGE_UNAVAILABLE",
        "SCR_ALLERGY_INPUT_UNAVAILABLE",
        "SCR_DOSE_INPUT_UNAVAILABLE",
      ])
    );
    for (const row of approvePhaseRows) {
      expect(row["disposition"]).toBe("REQUIRES_ACKNOWLEDGEMENT");
    }
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

    // B works through every outstanding finding — the interaction and
    // the two axes this platform cannot supply.
    await acknowledge(PHARMACIST_B, outstandingFingerprints(fake), "ack-by-b");

    await withTenancyContext(ctxFor(PHARMACIST_A), async () => {
      await expect(
        executeCommand(ApprovePV1, { orderId: ORDER_ID }, { idempotencyKey: "approve-by-a" })
      ).rejects.toMatchObject({
        code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
        metadata: expect.objectContaining({
          pharmacistUserId: PHARMACIST_A,
          outstandingFingerprints: expect.arrayContaining([
            INTERACTION_FINGERPRINT,
            ...UNSUPPLIED_AXIS_FINGERPRINTS,
          ]),
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
    const fake = buildFlowFake();
    configureBus(fake.client);
    configureClinicalScreening({ knowledgeSource: createInMemoryDrugKnowledgeSource() });

    await startReview();
    const first = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: GAP_FINGERPRINT },
        { idempotencyKey: "ack-1" }
      )
    );
    // A DIFFERENT idempotency key, so the bus does not replay: this
    // exercises the row-level guard rather than the bus's cache.
    const second = await withTenancyContext(ctxFor(PHARMACIST_A), () =>
      executeCommand(
        AcknowledgePV1ScreeningFinding,
        { orderId: ORDER_ID, fingerprint: GAP_FINGERPRINT },
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

    // Clear on the CLINICAL axes at start: the candidate is known and
    // nothing else is on the profile, so interaction and duplication
    // both ran and found nothing. The two unsupplied axes report
    // themselves, as they do on every screen — and the pharmacist
    // settles those while reading the order.
    const startFindings = callsOf(fake.calls, "orderScreeningFinding", "createMany").flatMap(
      (c) => (c.args as { data: Array<Record<string, unknown>> }).data
    );
    expect(startFindings.map((r) => r["code"]).sort()).toEqual([
      "SCR_ALLERGY_INPUT_UNAVAILABLE",
      "SCR_DOSE_INPUT_UNAVAILABLE",
    ]);
    await acknowledge(PHARMACIST_A, UNSUPPLIED_AXIS_FINGERPRINTS, "ack-gaps");

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
        // Exactly the interaction: the platform gaps were already
        // settled before the profile moved, so what is outstanding is
        // precisely what changed under the review.
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
