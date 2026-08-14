import { afterEach, describe, expect, it, vi } from "vitest";

import { labelReprintRateReport, REPRINT_REASON_MISSING } from "./label-reprint-rate.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";

interface FakeGroup {
  reprintReasonCode: string | null;
  _count: { _all: number };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>, printJobs: number) {
  return {
    printJob: {
      groupBy: vi.fn(async (_args: unknown) => groups),
      count: vi.fn(async (_args: unknown) => printJobs),
    },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("labelReprintRateReport — counts + rates", () => {
  it("ranks reasons by count and rates reprints against all printing", async () => {
    const client = fakeClient(
      [
        { reprintReasonCode: "SMUDGED", _count: { _all: 7 } },
        { reprintReasonCode: "PRINTER_JAM", _count: { _all: 2 } },
        { reprintReasonCode: "LOST_LABEL", _count: { _all: 1 } },
      ],
      200
    );

    const result = await labelReprintRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.reprintReasonCode)).toEqual([
      "SMUDGED",
      "PRINTER_JAM",
      "LOST_LABEL",
    ]);
    expect(result.rows[0]).toEqual({
      reprintReasonCode: "SMUDGED",
      reprintCount: 7,
      shareOfReprintsBps: 7000, // 7/10
    });
    expect(result.aggregates).toEqual({
      totalReprints: 10,
      totalPrintJobs: 200,
      reprintRateBps: 500, // 10/200 = 5%
      distinctReasonCodes: 3,
    });
  });

  it("surfaces a reprint with no reason code instead of dropping it", async () => {
    // The print command requires a reason for a reprint, so a null here
    // means that invariant broke. Bucketing it keeps it visible; the
    // alternative hides the exact rows worth investigating.
    const client = fakeClient(
      [
        { reprintReasonCode: "SMUDGED", _count: { _all: 3 } },
        { reprintReasonCode: null, _count: { _all: 1 } },
      ],
      100
    );

    const result = await labelReprintRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.reprintReasonCode)).toContain(REPRINT_REASON_MISSING);
    expect(result.aggregates["totalReprints"]).toBe(4);
  });

  it("reports zero rates rather than dividing by zero when nothing printed", async () => {
    const client = fakeClient([], 0);

    const result = await labelReprintRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalReprints: 0,
      totalPrintJobs: 0,
      reprintRateBps: 0,
      distinctReasonCodes: 0,
    });
  });

  it("sorts equal counts by reason so the CSV is stable", async () => {
    const client = fakeClient(
      [
        { reprintReasonCode: "SMUDGED", _count: { _all: 2 } },
        { reprintReasonCode: "DAMAGED", _count: { _all: 2 } },
      ],
      10
    );

    const result = await labelReprintRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.reprintReasonCode)).toEqual(["DAMAGED", "SMUDGED"]);
  });
});

describe("labelReprintRateReport — query shape", () => {
  it("filters reprints on isReprint and windows on requestedAt", async () => {
    const client = fakeClient([], 0);

    await labelReprintRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.printJob.groupBy.mock.calls[0]![0] as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(args.by).toEqual(["reprintReasonCode"]);
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      isReprint: true,
      // requestedAt, not completedAt: a queued or failed reprint is
      // still rework, and windowing on completion would drop failures.
      requestedAt: { gte: window.from, lte: window.to },
    });
  });

  it("counts every print job as the denominator, reprint or not", async () => {
    const client = fakeClient([], 0);

    await labelReprintRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.printJob.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).not.toHaveProperty("isReprint");
    expect(args.where).toMatchObject({ organizationId: ORG_ID });
  });
});

describe("labelReprintRateReport — clinic scope", () => {
  it("narrows BOTH the reprint groups and the denominator through the order relation", async () => {
    const client = fakeClient([], 0);

    await labelReprintRateReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_ID },
      window
    );

    // Both halves must be narrowed. Scoping only the numerator would
    // divide one clinic's reprints by the whole org's printing and
    // report a rate far lower than reality.
    const groupArgs = client.printJob.groupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    const countArgs = client.printJob.count.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(groupArgs.where).toMatchObject({ order: { clinicId: CLINIC_ID } });
    expect(countArgs.where).toMatchObject({ order: { clinicId: CLINIC_ID } });
  });

  it("omits the clinic filter entirely at org scope", async () => {
    const client = fakeClient([], 0);

    await labelReprintRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const groupArgs = client.printJob.groupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(groupArgs.where).not.toHaveProperty("order");
  });
});
