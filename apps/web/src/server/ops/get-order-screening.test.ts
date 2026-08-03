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

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const VIEWER_ID = "00000000-0000-4000-8000-0000000000a1";
const COLLEAGUE_ID = "00000000-0000-4000-8000-0000000000a2";
const LATEST_COMMAND = "00000000-0000-4000-8000-0000000000c2";
const EARLIER_COMMAND = "00000000-0000-4000-8000-0000000000c1";

const LATEST_AT = new Date("2026-08-03T12:00:00.000Z");
const EARLIER_AT = new Date("2026-08-03T09:00:00.000Z");

const prismaMock = {
  orderScreeningFinding: { findMany: vi.fn() },
  orderScreeningAcknowledgement: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  withOrgScope: (_org: string, fn: () => unknown) => fn(),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

const { getOrderScreening } = await import("./get-order-screening.js");

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

afterEach(() => vi.clearAllMocks());

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

  it("separates platform-capability gaps from prescription-specific ones", async () => {
    givenFindings([
      findingRow({
        id: "f-clinical",
        code: "SCR_DRUG_INTERACTION",
        kind: "DRUG_DRUG_INTERACTION",
        fingerprint: "FP-CLINICAL",
      }),
      findingRow({
        id: "f-knowledge",
        code: "SCR_KNOWLEDGE_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        fingerprint: "FP-KNOWLEDGE",
      }),
      findingRow({
        id: "f-allergy-axis",
        code: "SCR_ALLERGY_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        fingerprint: "FP-ALLERGY-AXIS",
      }),
      findingRow({
        id: "f-dose-axis",
        code: "SCR_DOSE_INPUT_UNAVAILABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        fingerprint: "FP-DOSE-AXIS",
      }),
    ]);
    givenAcknowledgements([]);

    const screening = await read();
    const groupByFingerprint = new Map(screening?.findings.map((f) => [f.fingerprint, f.group]));
    expect(groupByFingerprint.get("FP-CLINICAL")).toBe("CLINICAL");
    // The knowledge source was asked and had no answer for this drug —
    // the pharmacist can close that themselves.
    expect(groupByFingerprint.get("FP-KNOWLEDGE")).toBe("PRESCRIPTION_COVERAGE");
    // These two say the question cannot be asked at all, on any order.
    expect(groupByFingerprint.get("FP-ALLERGY-AXIS")).toBe("PLATFORM_CAPABILITY");
    expect(groupByFingerprint.get("FP-DOSE-AXIS")).toBe("PLATFORM_CAPABILITY");
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
});
