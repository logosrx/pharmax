import { CommandStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scanFailureRateReport,
  SCAN_FAILURE_REPORT_CLINIC_SCOPE_UNSUPPORTED,
} from "./scan-failure-rate.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";

interface FakeGroup {
  errorCode: string | null;
  _count: { _all: number };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>, attempts: number) {
  return {
    commandLog: {
      groupBy: vi.fn(async (_args: unknown) => groups),
      count: vi.fn(async (_args: unknown) => attempts),
    },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("scanFailureRateReport — counts + rates", () => {
  it("ranks reason codes by count and rates them against all fill attempts", async () => {
    const client = fakeClient(
      [
        { errorCode: "FILL_SCAN_NDC_MISMATCH", _count: { _all: 6 } },
        { errorCode: "FILL_SCAN_LOT_MISMATCH", _count: { _all: 3 } },
        { errorCode: "FILL_SCAN_PARSE_FAILED", _count: { _all: 1 } },
      ],
      500
    );

    const result = await scanFailureRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.failureCode)).toEqual([
      "FILL_SCAN_NDC_MISMATCH",
      "FILL_SCAN_LOT_MISMATCH",
      "FILL_SCAN_PARSE_FAILED",
    ]);
    expect(result.rows[0]).toEqual({
      failureCode: "FILL_SCAN_NDC_MISMATCH",
      failureCount: 6,
      shareOfFailuresBps: 6000, // 6/10
    });
    expect(result.aggregates).toEqual({
      totalScanFailures: 10,
      totalFillAttempts: 500,
      scanFailureRateBps: 200, // 10/500 = 2%
      distinctFailureCodes: 3,
    });
  });

  it("sorts equal counts by code so the CSV is stable", async () => {
    const client = fakeClient(
      [
        { errorCode: "FILL_SCAN_VIAL_LABEL_MISMATCH", _count: { _all: 2 } },
        { errorCode: "FILL_SCAN_DUPLICATE_LINE", _count: { _all: 2 } },
      ],
      10
    );

    const result = await scanFailureRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.failureCode)).toEqual([
      "FILL_SCAN_DUPLICATE_LINE",
      "FILL_SCAN_VIAL_LABEL_MISMATCH",
    ]);
  });

  it("reports zero rates rather than dividing by zero when nothing was filled", async () => {
    const client = fakeClient([], 0);

    const result = await scanFailureRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalScanFailures: 0,
      totalFillAttempts: 0,
      scanFailureRateBps: 0,
      distinctFailureCodes: 0,
    });
  });
});

describe("scanFailureRateReport — query shape", () => {
  it("scopes to the org, the scanning command, and FAILED rows with a scan code", async () => {
    const client = fakeClient([], 0);

    await scanFailureRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.commandLog.groupBy.mock.calls[0]![0] as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(args.by).toEqual(["errorCode"]);
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      commandName: "CompleteFill",
      status: CommandStatus.FAILED,
      // Prefix match, not an enumerated list: `@pharmax/scan` owns the
      // vocabulary, and a report that omits a newly-added failure mode
      // is worse than one showing an unfamiliar code.
      errorCode: { startsWith: "FILL_SCAN_" },
      startedAt: { gte: window.from, lte: window.to },
    });
  });

  it("counts ALL fill attempts as the denominator, not just failures", async () => {
    const client = fakeClient([], 0);

    await scanFailureRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.commandLog.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({
      organizationId: ORG_ID,
      commandName: "CompleteFill",
      startedAt: { gte: window.from, lte: window.to },
    });
    // Specifically must NOT filter on status/errorCode — "8 mismatches"
    // reads differently against 40 fills than against 4,000.
    expect(args.where).not.toHaveProperty("status");
    expect(args.where).not.toHaveProperty("errorCode");
  });
});

// The bus sets `targetOrderId` on the committed-refusal path but not
// on the thrown-error path, and scan failures throw — so these rows
// carry no order FK and cannot be attributed to a clinic. Refusing is
// the safe outcome; silently returning org-wide numbers to a
// clinic-scoped operator would be a cross-clinic leak.
describe("scanFailureRateReport — clinic scope is refused, not ignored", () => {
  it("throws when a clinic-scoped operator runs it", async () => {
    const client = fakeClient([{ errorCode: "FILL_SCAN_NDC_MISMATCH", _count: { _all: 1 } }], 1);

    await expect(
      scanFailureRateReport.run(
        { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_ID },
        window
      )
    ).rejects.toMatchObject({ code: SCAN_FAILURE_REPORT_CLINIC_SCOPE_UNSUPPORTED });
  });

  it("refuses before querying, so no cross-clinic rows are ever read", async () => {
    const client = fakeClient([], 0);

    await expect(
      scanFailureRateReport.run(
        { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_ID },
        window
      )
    ).rejects.toThrow();

    expect(client.commandLog.groupBy).not.toHaveBeenCalled();
    expect(client.commandLog.count).not.toHaveBeenCalled();
  });
});
