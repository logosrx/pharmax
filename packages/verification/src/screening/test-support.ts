// Prisma stubs for the tables the PV1 screening path touches.
//
// The PV1 command suites each build their own hand-rolled Prisma fake
// (see `approve-pv1.test.ts`). Screening added five more tables to
// that surface, and three suites needed the same five, so the stubs
// live here rather than being copied — a copied fake drifts, and a
// drifted fake is a test that passes for the wrong reason.
//
// Deliberately mutable: `state` is handed back to the caller so a test
// can push a prescription onto the patient's profile BETWEEN the
// StartPV1 screen and the ApprovePV1 re-screen, which is the scenario
// the re-screen exists for.
//
// Test-only. Not exported from the package index.

import { vi } from "vitest";

export interface StubPrescription {
  readonly id: string;
  readonly patientId: string;
  readonly drugNdc: string;
  readonly status: string;
  /**
   * Present on the stub row even though the screening path must never
   * select it. A drug name in a finding would put it into an
   * append-only table and every event derived from that table, so the
   * PHI test asserts this string never appears in a persisted row or
   * payload — which only proves anything if the fake is capable of
   * handing it out.
   */
  readonly drugName?: string;
}

export interface StubFinding {
  readonly fingerprint: string;
  readonly code: string;
  readonly severity: string;
  readonly certainty: string;
  readonly disposition: string;
  readonly occurredAt: Date;
  /**
   * `PV1_START` or `PV1_APPROVE`. Absent on rows a test seeded
   * directly rather than writing through a command.
   */
  readonly phase?: string;
  /**
   * The command that produced the screen this row belongs to. It is
   * how the console groups rows into "the latest screen" (see
   * `get-order-screening.ts`), so a test asserting what a pharmacist
   * would be shown has to be able to group the same way.
   */
  readonly commandLogId?: string;
  /**
   * Knowledge-release attribution as persisted. `null` is meaningful
   * (a source with no release identity) and distinct from absent (a
   * row a test seeded directly rather than writing through a command).
   */
  readonly knowledgeSourceCode?: string | null;
  readonly knowledgeReleaseVersion?: string | null;
}

export interface StubAcknowledgement {
  readonly id: string;
  readonly orderId: string;
  readonly pharmacistUserId: string;
  readonly fingerprint: string;
}

/**
 * One row of `patient_allergy`, as the screening path selects it.
 *
 * Only the coded columns: the screen must never read
 * `substanceLabelEnc` or `reactionNoteEnc`, so the stub cannot hand
 * them out and a test cannot accidentally prove the wrong thing.
 */
export interface StubAllergy {
  readonly id: string;
  readonly patientId: string;
  readonly substanceCode: string | null;
  readonly substanceCodeSystem: string;
  readonly category: string;
  readonly type: string;
  readonly criticality: string;
  readonly clinicalStatus: string;
  readonly verificationStatus: string;
}

/** One row of `patient_allergy_history_assertion`. */
export interface StubHistoryAssertion {
  readonly id: string;
  readonly patientId: string;
  readonly status: string;
  readonly assertedAt: Date;
}

export interface ScreeningStubState {
  patientId: string;
  orderLinePrescriptionIds: string[];
  prescriptions: StubPrescription[];
  /** Rows `order_screening_finding` already holds for the order. */
  persistedFindings: StubFinding[];
  acknowledgements: StubAcknowledgement[];
  /**
   * Mutable so a test can record an allergy BETWEEN the StartPV1 screen
   * and the ApprovePV1 re-screen — the allergy analogue of pushing a
   * prescription onto the profile mid-review.
   */
  allergies: StubAllergy[];
  historyAssertions: StubHistoryAssertion[];
}

export interface ScreeningStubOptions {
  readonly patientId?: string;
  readonly orderLinePrescriptionIds?: ReadonlyArray<string>;
  readonly prescriptions?: ReadonlyArray<StubPrescription>;
  readonly persistedFindings?: ReadonlyArray<StubFinding>;
  readonly acknowledgements?: ReadonlyArray<StubAcknowledgement>;
  /**
   * Default EMPTY, which resolves DRUG_ALLERGY to
   * NOT_RECORDED_FOR_SUBJECT — the correct answer for a patient nobody
   * has asked, and therefore the right default for a fixture that says
   * nothing about allergies.
   */
  readonly allergies?: ReadonlyArray<StubAllergy>;
  readonly historyAssertions?: ReadonlyArray<StubHistoryAssertion>;
}

/**
 * A patient whose allergy history HAS been taken and found empty.
 *
 * The default posture for a fixture about something other than
 * allergies. Without an assertion the DRUG_ALLERGY axis resolves to
 * NOT_RECORDED_FOR_SUBJECT and contributes an acknowledge-tier gap,
 * which would make every unrelated PV1 test fail on a screening gate
 * rather than on the thing it is testing. Saying "history taken, none
 * found" keeps those tests about their own subject and is what a
 * routine, correctly-intaked patient looks like.
 */
export function historyTakenNoKnownAllergies(
  patientId: string,
  assertedAt = new Date("2026-01-01T00:00:00.000Z")
): StubHistoryAssertion {
  return {
    id: "00000000-0000-4000-8000-00000000b001",
    patientId,
    status: "NO_KNOWN_ALLERGIES",
    assertedAt,
  };
}

/**
 * A screenable MEDICATION allergy, for tests that need the axis to come
 * back AVAILABLE. Synthetic RxNorm-shaped code; no real patient data.
 */
export function screenableStubAllergy(overrides: Partial<StubAllergy> = {}): StubAllergy {
  return {
    id: "00000000-0000-4000-8000-00000000a001",
    patientId: "00000000-0000-4000-8000-0000000000d1",
    substanceCode: "TEST-INGREDIENT-1",
    substanceCodeSystem: "RXNORM",
    category: "MEDICATION",
    type: "ALLERGY",
    criticality: "LOW",
    clinicalStatus: "ACTIVE",
    verificationStatus: "CONFIRMED",
    ...overrides,
  };
}

export type RecordCall = (table: string, op: string, args: unknown) => void;

interface WhereArgs {
  readonly where?: Record<string, unknown>;
  readonly data?: unknown;
  readonly select?: unknown;
  readonly orderBy?: unknown;
}

export interface ScreeningStubs {
  readonly state: ScreeningStubState;
  /** Spread into the fake's `order` model alongside update/updateMany. */
  readonly order: { findFirst: ReturnType<typeof vi.fn> };
  readonly orderLine: { findMany: ReturnType<typeof vi.fn> };
  readonly prescription: { findMany: ReturnType<typeof vi.fn> };
  readonly orderScreeningFinding: {
    createMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  readonly orderScreeningAcknowledgement: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  readonly patientAllergy: { findMany: ReturnType<typeof vi.fn> };
  readonly patientAllergyHistoryAssertion: { findFirst: ReturnType<typeof vi.fn> };
}

export function createScreeningStubs(
  record: RecordCall,
  options: ScreeningStubOptions = {}
): ScreeningStubs {
  const state: ScreeningStubState = {
    patientId: options.patientId ?? "00000000-0000-4000-8000-0000000000d1",
    orderLinePrescriptionIds: [...(options.orderLinePrescriptionIds ?? [])],
    prescriptions: [...(options.prescriptions ?? [])],
    persistedFindings: [...(options.persistedFindings ?? [])],
    acknowledgements: [...(options.acknowledgements ?? [])],
    allergies: [...(options.allergies ?? [])],
    historyAssertions: [...(options.historyAssertions ?? [])],
  };

  let nextAcknowledgementId = 1;

  return {
    state,
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        record("order", "findFirst", args);
        return { patientId: state.patientId };
      }),
    },
    orderLine: {
      findMany: vi.fn(async (args: unknown) => {
        record("orderLine", "findMany", args);
        return state.orderLinePrescriptionIds.map((prescriptionId) => ({ prescriptionId }));
      }),
    },
    prescription: {
      findMany: vi.fn(async (args: unknown) => {
        record("prescription", "findMany", args);
        const where = (args as WhereArgs).where ?? {};
        const idFilter = where["id"] as { in?: ReadonlyArray<string> } | undefined;
        if (idFilter?.in !== undefined) {
          const wanted = new Set(idFilter.in);
          return state.prescriptions.filter((p) => wanted.has(p.id));
        }
        return state.prescriptions.filter(
          (p) => p.patientId === where["patientId"] && p.status === where["status"]
        );
      }),
    },
    orderScreeningFinding: {
      createMany: vi.fn(async (args: unknown) => {
        record("orderScreeningFinding", "createMany", args);
        const rows = (args as { data: ReadonlyArray<Record<string, unknown>> }).data;
        // Persisted rows feed the acknowledge command's "was this
        // finding actually shown?" lookup, so the stub keeps them.
        for (const row of rows) {
          state.persistedFindings.push({
            fingerprint: String(row["fingerprint"]),
            code: String(row["code"]),
            severity: String(row["severity"]),
            certainty: String(row["certainty"]),
            disposition: String(row["disposition"]),
            occurredAt: row["occurredAt"] as Date,
            phase: String(row["phase"]),
            commandLogId: String(row["commandLogId"]),
            knowledgeSourceCode: (row["knowledgeSourceCode"] ?? null) as string | null,
            knowledgeReleaseVersion: (row["knowledgeReleaseVersion"] ?? null) as string | null,
          });
        }
        return { count: rows.length };
      }),
      findFirst: vi.fn(async (args: unknown) => {
        record("orderScreeningFinding", "findFirst", args);
        const where = (args as WhereArgs).where ?? {};
        const matches = state.persistedFindings.filter(
          (f) => f.fingerprint === where["fingerprint"]
        );
        if (matches.length === 0) return null;
        // Mirrors `orderBy: { occurredAt: "desc" }`.
        return [...matches].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
      }),
    },
    orderScreeningAcknowledgement: {
      findMany: vi.fn(async (args: unknown) => {
        record("orderScreeningAcknowledgement", "findMany", args);
        const where = (args as WhereArgs).where ?? {};
        const fingerprintFilter = where["fingerprint"] as
          { in?: ReadonlyArray<string> } | undefined;
        const wanted = fingerprintFilter?.in === undefined ? null : new Set(fingerprintFilter.in);
        return state.acknowledgements
          .filter(
            (a) =>
              a.orderId === where["orderId"] &&
              a.pharmacistUserId === where["pharmacistUserId"] &&
              (wanted === null || wanted.has(a.fingerprint))
          )
          .map((a) => ({ fingerprint: a.fingerprint }));
      }),
      findFirst: vi.fn(async (args: unknown) => {
        record("orderScreeningAcknowledgement", "findFirst", args);
        const where = (args as WhereArgs).where ?? {};
        const hit = state.acknowledgements.find(
          (a) =>
            a.orderId === where["orderId"] &&
            a.pharmacistUserId === where["pharmacistUserId"] &&
            a.fingerprint === where["fingerprint"]
        );
        return hit === undefined ? null : { id: hit.id };
      }),
      create: vi.fn(async (args: unknown) => {
        record("orderScreeningAcknowledgement", "create", args);
        const data = (args as { data: Record<string, unknown> }).data;
        const id = `ack-${nextAcknowledgementId}`;
        nextAcknowledgementId += 1;
        state.acknowledgements.push({
          id,
          orderId: String(data["orderId"]),
          pharmacistUserId: String(data["pharmacistUserId"]),
          fingerprint: String(data["fingerprint"]),
        });
        return { id };
      }),
    },
    patientAllergy: {
      findMany: vi.fn(async (args: unknown) => {
        record("patientAllergy", "findMany", args);
        const where = (args as WhereArgs).where ?? {};
        // Mirrors the real query, which filters ACTIVE in SQL so the
        // index does the work. A stub that returned every row would let
        // an in-memory-only filter pass a test the database would fail.
        return state.allergies.filter(
          (a) =>
            a.patientId === where["patientId"] &&
            (where["clinicalStatus"] === undefined || a.clinicalStatus === where["clinicalStatus"])
        );
      }),
    },
    patientAllergyHistoryAssertion: {
      findFirst: vi.fn(async (args: unknown) => {
        record("patientAllergyHistoryAssertion", "findFirst", args);
        const where = (args as WhereArgs).where ?? {};
        const matches = state.historyAssertions.filter((a) => a.patientId === where["patientId"]);
        if (matches.length === 0) return null;
        // Mirrors `orderBy: [{ assertedAt: "desc" }, ...]` — latest
        // assertion wins, which is the rule the screening layer relies
        // on to let a corrected history supersede an earlier one.
        return [...matches].sort((a, b) => b.assertedAt.getTime() - a.assertedAt.getTime())[0];
      }),
    },
  };
}
