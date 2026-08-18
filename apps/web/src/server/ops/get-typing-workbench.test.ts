// getTypingWorkbench contract tests.
//
// The projection's job is to give the review panel everything it needs
// to be checkable, so the assertions are about exactly that:
//
//   - The order `version` is carried through, because the accept form
//     submits it as `expectedOrderVersion`. If this were dropped or
//     stale-defaulted, a proposal accepted from an old tab would land
//     on top of whatever moved since.
//   - Proposals are split into open vs already-decided, and grouped to
//     the right prescription. A proposal shown under the wrong line is
//     worse than one not shown at all.
//   - The LATEST run wins per prescription, so a second review does not
//     leave the first run's skip reason on screen.
//   - JSON before/after values render as text, including null, which
//     must read as a word rather than an empty cell.
//
// All data is synthetic. No PHI.

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DatabaseModule from "@pharmax/database";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const RX_A = "00000000-0000-4000-8000-0000000000b1";
const RX_B = "00000000-0000-4000-8000-0000000000b2";
const LINE_A = "00000000-0000-4000-8000-0000000000c1";
const LINE_B = "00000000-0000-4000-8000-0000000000c2";
const RUN_NEW = "00000000-0000-4000-8000-0000000000f2";
const RUN_OLD = "00000000-0000-4000-8000-0000000000f1";

const prismaMock = {
  order: { findFirst: vi.fn() },
  orderLine: { findMany: vi.fn() },
  aiAssistPolicy: { findFirst: vi.fn() },
  typingSuggestion: { findMany: vi.fn() },
  typingSuggestionRun: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", async () => {
  const actual = await vi.importActual<typeof DatabaseModule>("@pharmax/database");
  return {
    ...actual,
    prisma: prismaMock,
    readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
    withOrgScope: (_org: string, fn: () => unknown) => fn(),
    readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
  };
});

const { getTypingWorkbench } = await import("./get-typing-workbench.js");

function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    externalOrderNumber: "EXT-TYPE-1",
    currentStatus: "TYPING_IN_PROGRESS",
    version: 7,
    currentAssigneeUserId: "00000000-0000-4000-8000-000000000009",
    ...overrides,
  };
}

function prescription(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    rxNumber: id === RX_A ? "RX-100001" : "RX-100002",
    drugNdc: "00093-0058-01",
    drugName: "Metformin",
    drugStrength: "500 mg",
    drugForm: "TABLET",
    quantityAuthorized: "60",
    daysSupply: 30,
    refillsAuthorized: 2,
    refillsRemaining: 2,
    daw: 0,
    originalDateWritten: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2027-08-01T00:00:00.000Z"),
    earliestFillDate: null,
    controlledSubstanceSchedule: "NON_CONTROLLED",
    sigStructureKind: "FIXED",
    doseAmount: "1",
    doseUnit: "TABLET",
    dosesPerDay: "2",
    ...overrides,
  };
}

function lineRow(lineId: string, rxId: string, rxOverrides: Record<string, unknown> = {}) {
  return { id: lineId, prescriptionId: rxId, prescription: prescription(rxId, rxOverrides) };
}

function suggestion(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    prescriptionId: RX_A,
    source: "DETERMINISTIC",
    status: "PROPOSED",
    findingCode: "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED",
    field: "refillsRemaining",
    currentValue: 4,
    suggestedValue: 2,
    rationale: "Refills remaining cannot exceed refills authorized.",
    confidencePercent: null,
    dismissReasonCode: null,
    resolvedAt: null,
    ...overrides,
  };
}

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    prescriptionId: RX_A,
    status: "COMPLETED",
    modelSuggestionsPermitted: true,
    modelSkipReasonCode: null,
    failureCode: null,
    deterministicFindingCount: 1,
    minConfidencePercent: 90,
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    sigOmittedByPhiTripwire: false,
    createdAt: new Date("2026-08-16T12:00:00.000Z"),
    completedAt: new Date("2026-08-16T12:00:04.000Z"),
    ...overrides,
  };
}

/** Default: two lines, no suggestions, no runs, policy enabled. */
function primeMocks(
  opts: {
    order?: Record<string, unknown> | null;
    lines?: ReadonlyArray<unknown>;
    suggestions?: ReadonlyArray<unknown>;
    runs?: ReadonlyArray<unknown>;
    policy?: { typingAssistEnabled: boolean } | null;
  } = {}
) {
  prismaMock.order.findFirst.mockResolvedValueOnce(
    opts.order === undefined ? orderRow() : opts.order
  );
  prismaMock.orderLine.findMany.mockResolvedValueOnce(
    opts.lines ?? [lineRow(LINE_A, RX_A), lineRow(LINE_B, RX_B)]
  );
  prismaMock.aiAssistPolicy.findFirst.mockResolvedValueOnce(
    opts.policy === undefined ? { typingAssistEnabled: true } : opts.policy
  );
  prismaMock.typingSuggestion.findMany.mockResolvedValueOnce(opts.suggestions ?? []);
  prismaMock.typingSuggestionRun.findMany.mockResolvedValueOnce(opts.runs ?? []);
}

afterEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: these fixtures queue values
  // with `mockResolvedValueOnce`, and the not-found case returns before
  // consuming its queue. Clearing only call history would leave those
  // values to be picked up by the next test, in the wrong order.
  vi.resetAllMocks();
});

describe("getTypingWorkbench — order header", () => {
  it("carries the order version through for the accept form's CAS token", async () => {
    primeMocks();

    const wb = await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(wb).not.toBeNull();
    expect(wb?.version).toBe(7);
    expect(wb?.currentStatus).toBe("TYPING_IN_PROGRESS");
    expect(wb?.externalOrderNumber).toBe("EXT-TYPE-1");
  });

  it("returns null for an order outside the organization", async () => {
    primeMocks({ order: null });

    expect(await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID })).toBeNull();
  });

  it("scopes every read by organizationId as defense in depth", async () => {
    // The Prisma extension is the real gate; the explicit predicate is
    // the second lock. A loader that relied on the extension alone
    // would leak the moment it ran outside a tenancy frame.
    primeMocks();

    await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    for (const call of [
      prismaMock.order.findFirst.mock.calls[0],
      prismaMock.orderLine.findMany.mock.calls[0],
      prismaMock.typingSuggestion.findMany.mock.calls[0],
      prismaMock.typingSuggestionRun.findMany.mock.calls[0],
      prismaMock.aiAssistPolicy.findFirst.mock.calls[0],
    ]) {
      expect((call?.[0] as { where: Record<string, unknown> }).where).toMatchObject({
        organizationId: ORG_ID,
      });
    }
  });
});

describe("getTypingWorkbench — draft projection", () => {
  it("normalizes Decimal columns to strings so no Decimal reaches the page", async () => {
    primeMocks({
      lines: [lineRow(LINE_A, RX_A, { quantityAuthorized: "90.5000", dosesPerDay: "1.5000" })],
    });

    const draft = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))
      ?.lines[0]?.draft;

    expect(draft?.quantityAuthorized).toBe("90.5000");
    expect(draft?.dosesPerDay).toBe("1.5000");
    expect(typeof draft?.daysSupply).toBe("number");
  });

  it("keeps unset optional dose fields null rather than coercing to a string", async () => {
    primeMocks({
      lines: [lineRow(LINE_A, RX_A, { doseAmount: null, doseUnit: null, dosesPerDay: null })],
    });

    const draft = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))
      ?.lines[0]?.draft;

    expect(draft?.doseAmount).toBeNull();
    expect(draft?.doseUnit).toBeNull();
    expect(draft?.dosesPerDay).toBeNull();
  });
});

describe("getTypingWorkbench — suggestion grouping", () => {
  it("attaches each proposal to its own prescription", async () => {
    primeMocks({
      suggestions: [
        suggestion({ id: "s-a", prescriptionId: RX_A }),
        suggestion({ id: "s-b", prescriptionId: RX_B, field: "daysSupply" }),
      ],
    });

    const wb = await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(wb?.lines[0]?.openSuggestions.map((s) => s.suggestionId)).toEqual(["s-a"]);
    expect(wb?.lines[1]?.openSuggestions.map((s) => s.suggestionId)).toEqual(["s-b"]);
  });

  it("splits open proposals from already-decided ones", async () => {
    primeMocks({
      suggestions: [
        suggestion({ id: "open-1", status: "PROPOSED" }),
        suggestion({ id: "accepted-1", status: "ACCEPTED", resolvedAt: new Date() }),
        suggestion({
          id: "dismissed-1",
          status: "DISMISSED",
          dismissReasonCode: "INTENTIONAL_AS_PRESCRIBED",
          resolvedAt: new Date(),
        }),
        suggestion({ id: "superseded-1", status: "SUPERSEDED", resolvedAt: new Date() }),
      ],
    });

    const line = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))
      ?.lines[0];

    expect(line?.openSuggestions.map((s) => s.suggestionId)).toEqual(["open-1"]);
    expect(line?.resolvedSuggestions.map((s) => s.suggestionId)).toEqual([
      "accepted-1",
      "dismissed-1",
      "superseded-1",
    ]);
  });

  it("renders JSON values as text, including null as a word", async () => {
    // An empty cell where a value belongs reads as a broken render, and
    // "clear this field" is a real proposal that must be legible.
    primeMocks({
      suggestions: [
        suggestion({
          id: "s-null",
          field: "earliestFillDate",
          currentValue: "2026-09-01",
          suggestedValue: null,
        }),
        suggestion({
          id: "s-str",
          field: "drugForm",
          currentValue: null,
          suggestedValue: "CAPSULE",
        }),
      ],
    });

    const open = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))?.lines[0]
      ?.openSuggestions;

    expect(open?.[0]).toMatchObject({ currentValue: "2026-09-01", suggestedValue: "(none)" });
    expect(open?.[1]).toMatchObject({ currentValue: "(none)", suggestedValue: "CAPSULE" });
  });

  it("caps the already-decided list so history cannot crowd out open work", async () => {
    primeMocks({
      suggestions: Array.from({ length: 20 }, (_v, i) =>
        suggestion({ id: `old-${i}`, status: "SUPERSEDED", resolvedAt: new Date() })
      ),
    });

    const line = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))
      ?.lines[0];

    expect(line?.resolvedSuggestions).toHaveLength(8);
  });
});

describe("getTypingWorkbench — run selection", () => {
  it("keeps the newest run per prescription and drops older ones", async () => {
    // Runs arrive newest-first. Showing an older run would leave a
    // stale skip reason or failure code on screen after a fresh review.
    primeMocks({
      runs: [
        run(RUN_NEW, { status: "COMPLETED", failureCode: null }),
        run(RUN_OLD, { status: "FAILED", failureCode: "MODEL_CALL_FAILED" }),
      ],
    });

    const latest = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))
      ?.lines[0]?.latestRun;

    expect(latest?.runId).toBe(RUN_NEW);
    expect(latest?.status).toBe("COMPLETED");
    expect(latest?.failureCode).toBeNull();
  });

  it("reports no run for a prescription that has never been reviewed", async () => {
    primeMocks({ runs: [run(RUN_NEW, { prescriptionId: RX_A })] });

    const wb = await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(wb?.lines[0]?.latestRun?.runId).toBe(RUN_NEW);
    expect(wb?.lines[1]?.latestRun).toBeNull();
  });

  it("surfaces the skip reason and the tripwire flag for the panel to explain", async () => {
    primeMocks({
      runs: [
        run(RUN_NEW, {
          status: "MODEL_SKIPPED",
          modelSuggestionsPermitted: false,
          modelSkipReasonCode: "PRODUCT_GUARDRAIL_DISABLED",
          sigOmittedByPhiTripwire: true,
        }),
      ],
    });

    const latest = (await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID }))
      ?.lines[0]?.latestRun;

    expect(latest).toMatchObject({
      status: "MODEL_SKIPPED",
      modelSuggestionsPermitted: false,
      modelSkipReasonCode: "PRODUCT_GUARDRAIL_DISABLED",
      sigOmittedByPhiTripwire: true,
    });
  });
});

describe("getTypingWorkbench — org policy", () => {
  it("reports typing assist as disabled when the org has no policy row", async () => {
    // No row means never configured, which the panel says out loud
    // instead of offering a button whose only outcome is a skip.
    primeMocks({ policy: null });

    const wb = await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(wb?.typingAssistEnabled).toBe(false);
  });

  it("reports typing assist as disabled when the org turned it off", async () => {
    primeMocks({ policy: { typingAssistEnabled: false } });

    const wb = await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(wb?.typingAssistEnabled).toBe(false);
  });
});

describe("getTypingWorkbench — degenerate orders", () => {
  it("returns an empty line list rather than throwing on an order with no lines", async () => {
    primeMocks({ lines: [] });

    const wb = await getTypingWorkbench({ organizationId: ORG_ID, orderId: ORDER_ID });

    expect(wb?.lines).toEqual([]);
  });
});
