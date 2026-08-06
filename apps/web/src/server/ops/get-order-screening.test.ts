// Tests for the PV1 screening projection the console reads.
//
// Three properties here are safety properties, not presentation ones,
// and each has a failure mode that is silent rather than loud:
//
//   - Only the LATEST screen is shown. Showing an older screen's rows
//     resurrects findings whose clinical situation no longer exists.
//   - An acknowledgement counts only for the pharmacist who gave it. A
//     projection that inherited a colleague's would tell the viewer
//     they had nothing left to decide, right up until their approval
//     was refused.
//   - A HARD_STOP is never acknowledgeable, whatever rows exist
//     alongside it.
//
// CLEAN ROOM / PHI: every code below is synthetic and no fixture
// carries a patient identifier or a drug name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const VIEWER_ID = "00000000-0000-4000-8000-0000000000a1";
const COLLEAGUE_ID = "00000000-0000-4000-8000-0000000000a2";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000d1";
const LATEST_COMMAND = "00000000-0000-4000-8000-0000000000c2";
const EARLIER_COMMAND = "00000000-0000-4000-8000-0000000000c1";

const LATEST_AT = new Date("2026-08-03T12:00:00.000Z");
const EARLIER_AT = new Date("2026-08-03T09:00:00.000Z");

const prismaMock = {
  orderScreeningFinding: { findMany: vi.fn() },
  orderScreeningAcknowledgement: { findMany: vi.fn() },
  // Patient-scoped coverage reads. Defaulted per-test in `beforeEach`
  // to "no patient acknowledgements, empty allergy record" so every
  // pre-existing fixture keeps meaning what it meant.
  patientScreeningAcknowledgement: { findMany: vi.fn() },
  order: { findFirst: vi.fn() },
  patientAllergy: { findMany: vi.fn() },
  patientAllergyHistoryAssertion: { findMany: vi.fn() },
};

// Partial mock: the projection now imports `@pharmax/verification`,
// which reaches `@pharmax/database` for enums and types a full module
// replacement would erase. Only the client surface is faked.
vi.mock("@pharmax/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: prismaMock,
    readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
    withOrgScope: (_org: string, fn: () => unknown) => fn(),
    readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
  };
});

const { getOrderScreening } = await import("./get-order-screening.js");
const { patientRecordStateToken } = await import("@pharmax/verification");

/**
 * The record-state token the projection will compute against the
 * mocked (empty) allergy record — via the REAL hash function, so a
 * seeded "current" acknowledgement matches by the same computation
 * the gate uses, not by a copied literal.
 */
async function emptyRecordToken(): Promise<string> {
  const tx = {
    patientAllergy: { findMany: async () => [] },
    patientAllergyHistoryAssertion: { findMany: async () => [] },
  } as unknown as Parameters<typeof patientRecordStateToken>[0]["tx"];
  return patientRecordStateToken(
    { tx, organizationId: ORG_ID, patientId: PATIENT_ID },
    "DRUG_ALLERGY"
  );
}

interface FindingRowOverrides {
  readonly id?: string;
  readonly code?: string;
  readonly kind?: string;
  readonly severity?: string;
  readonly certainty?: string;
  readonly disposition?: string;
  readonly fingerprint?: string;
  readonly reason?: string;
  readonly citation?: string | null;
  readonly triggers?: unknown;
  readonly commandLogId?: string;
  readonly occurredAt?: Date;
}

function findingRow(overrides: FindingRowOverrides = {}) {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-0000000000f1",
    code: overrides.code ?? "SCR_DRUG_INTERACTION",
    kind: overrides.kind ?? "DRUG_DRUG_INTERACTION",
    severity: overrides.severity ?? "MAJOR",
    certainty: overrides.certainty ?? "PROBABLE",
    disposition: overrides.disposition ?? "REQUIRES_ACKNOWLEDGEMENT",
    fingerprint: overrides.fingerprint ?? "FP-INTERACTION",
    reason:
      overrides.reason ?? "Synthetic interaction between INGREDIENT_ALFA and INGREDIENT_BRAVO.",
    citation: overrides.citation ?? null,
    triggers: overrides.triggers ?? [
      { source: "CANDIDATE_DRUG", recordId: "rx-1", code: "INGREDIENT_ALFA" },
      { source: "PROFILE_MEDICATION", recordId: "rx-2", code: "INGREDIENT_BRAVO" },
    ],
    phase: "PV1_START",
    commandLogId: overrides.commandLogId ?? LATEST_COMMAND,
    occurredAt: overrides.occurredAt ?? LATEST_AT,
    createdAt: overrides.occurredAt ?? LATEST_AT,
  };
}

/** Rows come back newest-first, the way the query orders them. */
function givenFindings(rows: ReadonlyArray<ReturnType<typeof findingRow>>): void {
  prismaMock.orderScreeningFinding.findMany.mockResolvedValueOnce(rows);
}

function givenAcknowledgements(fingerprints: ReadonlyArray<string>): void {
  prismaMock.orderScreeningAcknowledgement.findMany.mockResolvedValueOnce(
    fingerprints.map((fingerprint) => ({ fingerprint }))
  );
}

async function read(pharmacistUserId = VIEWER_ID) {
  return await getOrderScreening({
    organizationId: ORG_ID,
    orderId: ORDER_ID,
    pharmacistUserId,
  });
}

beforeEach(() => {
  prismaMock.order.findFirst.mockResolvedValue({ patientId: PATIENT_ID });
  prismaMock.patientScreeningAcknowledgement.findMany.mockResolvedValue([]);
  prismaMock.patientAllergy.findMany.mockResolvedValue([]);
  prismaMock.patientAllergyHistoryAssertion.findMany.mockResolvedValue([]);
});

afterEach(() => vi.resetAllMocks());

describe("getOrderScreening", () => {
  it("returns null when the order has never been screened", async () => {
    givenFindings([]);
    expect(await read()).toBeNull();
    expect(prismaMock.orderScreeningAcknowledgement.findMany).not.toHaveBeenCalled();
  });

  it("shows only the latest screen, not the union across screens", async () => {
    givenFindings([
      findingRow({ id: "f-new", fingerprint: "FP-NEW", commandLogId: LATEST_COMMAND }),
      findingRow({
        id: "f-old",
        fingerprint: "FP-RESOLVED",
        commandLogId: EARLIER_COMMAND,
        occurredAt: EARLIER_AT,
      }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    expect(screening?.findings.map((f) => f.fingerprint)).toEqual(["FP-NEW"]);
    expect(screening?.screenedAt).toEqual(LATEST_AT);
    // The acknowledgement lookup must not ask about the dropped row.
    const where = prismaMock.orderScreeningAcknowledgement.findMany.mock.calls[0]?.[0] as {
      where: { fingerprint: { in: ReadonlyArray<string> } };
    };
    expect(where.where.fingerprint.in).toEqual(["FP-NEW"]);
  });

  it("scopes the acknowledgement read to the viewing pharmacist", async () => {
    givenFindings([findingRow()]);
    givenAcknowledgements([]);

    await read(VIEWER_ID);

    const where = prismaMock.orderScreeningAcknowledgement.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(where.where["pharmacistUserId"]).toBe(VIEWER_ID);
    expect(where.where["organizationId"]).toBe(ORG_ID);
    expect(where.where["orderId"]).toBe(ORDER_ID);
  });

  it("does not treat a colleague's acknowledgement as satisfied", async () => {
    givenFindings([findingRow({ fingerprint: "FP-INTERACTION" })]);
    // The fake behaves like the table: it holds the colleague's
    // acknowledgement and nobody else's, and it honours whatever
    // `pharmacistUserId` predicate it is given. A projection that
    // dropped that predicate would therefore inherit the colleague's
    // judgement here, which is the leak this test exists to catch.
    prismaMock.orderScreeningAcknowledgement.findMany.mockImplementationOnce(
      (args: { where: { pharmacistUserId?: string } }) => {
        const table = [{ pharmacistUserId: COLLEAGUE_ID, fingerprint: "FP-INTERACTION" }];
        const scopedTo = args.where.pharmacistUserId;
        return Promise.resolve(
          table.filter((row) => scopedTo === undefined || row.pharmacistUserId === scopedTo)
        );
      }
    );

    const screening = await read(VIEWER_ID);
    expect(screening?.findings[0]?.acknowledgedByViewer).toBe(false);
    expect(screening?.findings[0]?.acknowledgeable).toBe(true);
    expect(screening?.outstandingCount).toBe(1);
  });

  it("marks the viewer's own acknowledgement settled and withdraws the control", async () => {
    givenFindings([findingRow({ fingerprint: "FP-INTERACTION" })]);
    givenAcknowledgements(["FP-INTERACTION"]);

    const screening = await read();
    expect(screening?.findings[0]?.acknowledgedByViewer).toBe(true);
    expect(screening?.findings[0]?.acknowledgeable).toBe(false);
    expect(screening?.outstandingCount).toBe(0);
  });

  it("never makes a HARD_STOP acknowledgeable, even with a matching acknowledgement row", async () => {
    givenFindings([
      findingRow({
        code: "SCR_DRUG_ALLERGY_DIRECT",
        kind: "DRUG_ALLERGY",
        severity: "CONTRAINDICATED",
        certainty: "DEFINITE",
        disposition: "HARD_STOP",
        fingerprint: "FP-HARD-STOP",
      }),
    ]);
    givenAcknowledgements(["FP-HARD-STOP"]);

    const screening = await read();
    expect(screening?.hardStopCount).toBe(1);
    expect(screening?.findings[0]?.acknowledgeable).toBe(false);
    expect(screening?.outstandingCount).toBe(0);
  });

  it("leaves an INFORMATIONAL finding with nothing to acknowledge", async () => {
    givenFindings([
      findingRow({ severity: "MINOR", disposition: "INFORMATIONAL", fingerprint: "FP-MINOR" }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    expect(screening?.findings[0]?.acknowledgeable).toBe(false);
    expect(screening?.outstandingCount).toBe(0);
  });

  it("separates platform-capability gaps from prescription-specific ones by remediation", async () => {
    // Grouped by the grading, NOT by the finding code, and this test is
    // built to fail if that ever regresses: the SAME code appears twice
    // with different severities and has to land in different groups.
    //
    // A code-based rule cannot be correct here, because every gap code
    // is raised for both reasons. `SCR_ALLERGY_INPUT_UNAVAILABLE` means
    // "no allergy capture exists" today and will mean "nobody recorded
    // allergies for this patient" once it does; `SCR_KNOWLEDGE_UNAVAILABLE`
    // means "no database is provisioned" or "this one code is missing
    // from a working one". Getting it wrong hands the pharmacist an
    // instruction they cannot follow in either direction.
    givenFindings([
      findingRow({
        id: "f-clinical",
        code: "SCR_DRUG_INTERACTION",
        kind: "DRUG_DRUG_INTERACTION",
        fingerprint: "FP-CLINICAL",
      }),
      // MODERATE: this database is provisioned and does not hold this
      // code. Somebody can verify the NDC or chase an update.
      findingRow({
        id: "f-knowledge-subject",
        code: "SCR_KNOWLEDGE_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        fingerprint: "FP-KNOWLEDGE-SUBJECT",
      }),
      // MINOR: no database is provisioned at all. Same code, and nobody
      // in the pharmacy can close it.
      findingRow({
        id: "f-knowledge-platform",
        code: "SCR_KNOWLEDGE_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MINOR",
        certainty: "DEFINITE",
        fingerprint: "FP-KNOWLEDGE-PLATFORM",
      }),
      // MINOR: no allergy capture in the product.
      findingRow({
        id: "f-allergy-platform",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MINOR",
        certainty: "DEFINITE",
        fingerprint: "FP-ALLERGY-PLATFORM",
      }),
      // MODERATE, same code: allergy capture exists and nobody recorded
      // any for this patient. Actionable, so it must NOT be filed under
      // "no pharmacist can resolve this".
      findingRow({
        id: "f-allergy-subject",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        fingerprint: "FP-ALLERGY-SUBJECT",
      }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    const groupByFingerprint = new Map(screening?.findings.map((f) => [f.fingerprint, f.group]));
    expect(groupByFingerprint.get("FP-CLINICAL")).toBe("CLINICAL");
    expect(groupByFingerprint.get("FP-KNOWLEDGE-SUBJECT")).toBe("PRESCRIPTION_COVERAGE");
    expect(groupByFingerprint.get("FP-ALLERGY-SUBJECT")).toBe("PRESCRIPTION_COVERAGE");
    expect(groupByFingerprint.get("FP-KNOWLEDGE-PLATFORM")).toBe("PLATFORM_CAPABILITY");
    expect(groupByFingerprint.get("FP-ALLERGY-PLATFORM")).toBe("PLATFORM_CAPABILITY");
  });

  it("files the compound-coverage codes under ORGANIZATION_COVERAGE, never platform capability", async () => {
    // These two codes grade MINOR, and MINOR's severity-recovery answer
    // is (and must remain, for historical rows) PLATFORM_CAPABILITY —
    // so if the code-first consult (`gapRemediationForFindingCode`)
    // were ever dropped from `groupFor`, both would silently fall into
    // "Checks Pharmax cannot perform yet". That block tells the
    // pharmacist NOBODY can close the gap, about a gap their own
    // formulary team can close — an instruction that cannot be
    // followed, which is exactly what this test exists to prevent.
    givenFindings([
      findingRow({
        id: "f-compound-uncoded",
        code: "SCR_COMPOUND_FORMULA_NOT_CODED",
        kind: "SCREENING_GAP",
        severity: "MINOR",
        certainty: "DEFINITE",
        disposition: "INFORMATIONAL",
        fingerprint: "FP-COMPOUND-UNCODED",
      }),
      findingRow({
        id: "f-compound-partial",
        code: "SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED",
        kind: "SCREENING_GAP",
        severity: "MINOR",
        certainty: "DEFINITE",
        disposition: "INFORMATIONAL",
        fingerprint: "FP-COMPOUND-PARTIAL",
      }),
      // Control: a MINOR gap on a code with no fixed remediation still
      // reads PLATFORM_CAPABILITY from its severity, as it always did.
      findingRow({
        id: "f-knowledge-platform",
        code: "SCR_KNOWLEDGE_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MINOR",
        certainty: "DEFINITE",
        fingerprint: "FP-KNOWLEDGE-PLATFORM",
      }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    const groupByFingerprint = new Map(screening?.findings.map((f) => [f.fingerprint, f.group]));
    expect(groupByFingerprint.get("FP-COMPOUND-UNCODED")).toBe("ORGANIZATION_COVERAGE");
    expect(groupByFingerprint.get("FP-COMPOUND-PARTIAL")).toBe("ORGANIZATION_COVERAGE");
    expect(groupByFingerprint.get("FP-KNOWLEDGE-PLATFORM")).toBe("PLATFORM_CAPABILITY");
  });

  it("files a gap whose grading this build cannot read under prescription coverage", async () => {
    // `severity` is TEXT so the vocabulary can grow, which means this
    // build can read a grade it does not know. Falling back to the group
    // that invites a look is the safe direction: telling somebody to
    // check is a cheaper error than telling them to ignore.
    givenFindings([
      findingRow({
        id: "f-future",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "SOMETHING_NEW",
        certainty: "DEFINITE",
        fingerprint: "FP-FUTURE",
      }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    expect(screening?.findings[0]?.group).toBe("PRESCRIPTION_COVERAGE");
  });

  it("orders most severe first so the finding that matters is at the top", async () => {
    givenFindings([
      findingRow({
        id: "f-1",
        severity: "MINOR",
        disposition: "INFORMATIONAL",
        fingerprint: "FP-1",
      }),
      findingRow({ id: "f-2", severity: "MODERATE", fingerprint: "FP-2" }),
      findingRow({
        id: "f-3",
        severity: "CONTRAINDICATED",
        certainty: "DEFINITE",
        disposition: "HARD_STOP",
        fingerprint: "FP-3",
      }),
      findingRow({ id: "f-4", severity: "MAJOR", fingerprint: "FP-4" }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    expect(screening?.findings.map((f) => f.severity)).toEqual([
      "CONTRAINDICATED",
      "MAJOR",
      "MODERATE",
      "MINOR",
    ]);
  });

  it("sorts a severity this build does not recognize to the bottom rather than throwing", async () => {
    // `severity` is TEXT so the vocabulary can grow; a future grade
    // must stay visible, it just loses its claim on the top.
    givenFindings([
      findingRow({ id: "f-future", severity: "CATASTROPHIC", fingerprint: "FP-FUTURE" }),
      findingRow({ id: "f-minor", severity: "MINOR", fingerprint: "FP-MINOR" }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    expect(screening?.findings.map((f) => f.fingerprint)).toEqual(["FP-MINOR", "FP-FUTURE"]);
  });

  it("de-duplicates trigger codes and survives an unreadable triggers payload", async () => {
    givenFindings([
      findingRow({
        id: "f-dupe",
        fingerprint: "FP-DUPE",
        triggers: [
          { source: "CANDIDATE_DRUG", recordId: "rx-1", code: "INGREDIENT_ALFA" },
          { source: "PROFILE_MEDICATION", recordId: "rx-2", code: "INGREDIENT_ALFA" },
          { source: "PROFILE_MEDICATION", recordId: "rx-3" },
          "not-an-object",
        ],
      }),
      findingRow({ id: "f-broken", fingerprint: "FP-BROKEN", triggers: "unreadable" }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    const byFingerprint = new Map(screening?.findings.map((f) => [f.fingerprint, f]));
    expect(byFingerprint.get("FP-DUPE")?.triggers.map((t) => t.code)).toEqual(["INGREDIENT_ALFA"]);
    expect(byFingerprint.get("FP-BROKEN")?.triggers).toEqual([]);
    expect(byFingerprint.get("FP-BROKEN")?.reason.length).toBeGreaterThan(0);
  });

  it("runs on a provided tx without opening its own scope", async () => {
    const fakeTx = {
      orderScreeningFinding: { findMany: vi.fn().mockResolvedValueOnce([findingRow()]) },
      orderScreeningAcknowledgement: { findMany: vi.fn().mockResolvedValueOnce([]) },
    };
    const screening = await getOrderScreening({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      pharmacistUserId: VIEWER_ID,
      tx: fakeTx as never,
    });
    expect(screening?.findings).toHaveLength(1);
    expect(prismaMock.orderScreeningFinding.findMany).not.toHaveBeenCalled();
  });

  describe("patient-scoped coverage", () => {
    /** The per-patient allergy-history gap, at its acknowledge-tier grading. */
    function allergyGapRow(fingerprint = "FP-ALLERGY-SUBJECT") {
      return findingRow({
        id: "f-allergy-subject",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        fingerprint,
      });
    }

    it("reports COVERED — visibly, with the date — and withdraws the control", async () => {
      // The suppression must be VISIBLE. The gate will pass this gap
      // on the strength of the patient-scoped acknowledgement, and a
      // panel that just showed nothing would read as "screened
      // clean". The view must carry when the judgement was given.
      givenFindings([allergyGapRow()]);
      givenAcknowledgements([]);
      prismaMock.patientScreeningAcknowledgement.findMany.mockResolvedValue([
        {
          fingerprint: "FP-ALLERGY-SUBJECT",
          recordStateToken: await emptyRecordToken(),
          acknowledgedAt: EARLIER_AT,
        },
      ]);

      const screening = await read();
      expect(screening?.findings[0]?.patientScopeCoverage).toEqual({
        kind: "COVERED",
        acknowledgedAt: EARLIER_AT,
      });
      expect(screening?.findings[0]?.acknowledgeable).toBe(false);
      expect(screening?.outstandingCount).toBe(0);

      // Scoped to the viewer and the patient — a colleague's
      // patient-scoped acknowledgement must be structurally unreadable
      // from here.
      const where = prismaMock.patientScreeningAcknowledgement.findMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(where.where["pharmacistUserId"]).toBe(VIEWER_ID);
      expect(where.where["patientId"]).toBe(PATIENT_ID);
      expect(where.where["organizationId"]).toBe(ORG_ID);
    });

    it("reports SUPERSEDED when the record changed since the acknowledgement, and re-prompts", async () => {
      // The re-arm made visible: the stored token no longer matches
      // the (empty-record) token the projection computes, so the old
      // judgement is reported as superseded and the control returns.
      givenFindings([allergyGapRow()]);
      givenAcknowledgements([]);
      prismaMock.patientScreeningAcknowledgement.findMany.mockResolvedValue([
        {
          fingerprint: "FP-ALLERGY-SUBJECT",
          recordStateToken: "stale-token-from-a-record-state-that-no-longer-exists",
          acknowledgedAt: EARLIER_AT,
        },
      ]);

      const screening = await read();
      expect(screening?.findings[0]?.patientScopeCoverage).toEqual({
        kind: "SUPERSEDED",
        lastAcknowledgedAt: EARLIER_AT,
      });
      expect(screening?.findings[0]?.acknowledgeable).toBe(true);
      expect(screening?.outstandingCount).toBe(1);
    });

    it("reports NONE for a never-acknowledged gap, which stays acknowledgeable", async () => {
      givenFindings([allergyGapRow()]);
      givenAcknowledgements([]);

      const screening = await read();
      expect(screening?.findings[0]?.patientScopeCoverage).toEqual({ kind: "NONE" });
      expect(screening?.findings[0]?.acknowledgeable).toBe(true);
    });

    it("never consults the patient table for a clinical finding", async () => {
      // The boundary, from the read side: a clinical finding carries
      // `patientScopeCoverage: null` and the patient-acknowledgement
      // table is not even queried — the same classifier the gate uses
      // decides both.
      givenFindings([findingRow({ fingerprint: "FP-INTERACTION" })]);
      givenAcknowledgements([]);

      const screening = await read();
      expect(screening?.findings[0]?.patientScopeCoverage).toBeNull();
      expect(prismaMock.patientScreeningAcknowledgement.findMany).not.toHaveBeenCalled();
      expect(prismaMock.order.findFirst).not.toHaveBeenCalled();
    });
  });
});
