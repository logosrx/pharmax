import { VerificationStage } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verificationRejectionRateReport } from "./verification-rejection-rate.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

interface FakeGroup {
  stage: VerificationStage;
  decision: "APPROVED" | "REJECTED";
  _count: { _all: number };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>) {
  return {
    verificationRecord: { groupBy: vi.fn(async () => groups) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("verificationRejectionRateReport — pivot + rates", () => {
  it("pivots (stage, decision) into per-stage rows with rejection rate (bps)", async () => {
    const client = fakeClient([
      { stage: VerificationStage.PV1, decision: "APPROVED", _count: { _all: 90 } },
      { stage: VerificationStage.PV1, decision: "REJECTED", _count: { _all: 10 } },
      { stage: VerificationStage.FINAL, decision: "APPROVED", _count: { _all: 49 } },
      { stage: VerificationStage.FINAL, decision: "REJECTED", _count: { _all: 1 } },
    ]);
    const result = await verificationRejectionRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(2);
    const pv1 = result.rows.find((r) => r.stage === VerificationStage.PV1)!;
    expect(pv1).toEqual({
      stage: VerificationStage.PV1,
      approvedCount: 90,
      rejectedCount: 10,
      totalCount: 100,
      rejectionRateBps: 1000, // 10%
    });
    const final = result.rows.find((r) => r.stage === VerificationStage.FINAL)!;
    expect(final.rejectionRateBps).toBe(200); // 1/50 = 2%

    expect(result.aggregates).toEqual({
      totalVerifications: 150,
      totalRejected: 11,
      overallRejectionRateBps: Math.round((11 / 150) * 10_000), // 733
      distinctStages: 2,
    });
  });

  it("orders PV1 before FINAL", async () => {
    const client = fakeClient([
      { stage: VerificationStage.FINAL, decision: "APPROVED", _count: { _all: 1 } },
      { stage: VerificationStage.PV1, decision: "APPROVED", _count: { _all: 1 } },
    ]);
    const result = await verificationRejectionRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows.map((r) => r.stage)).toEqual([
      VerificationStage.PV1,
      VerificationStage.FINAL,
    ]);
  });

  it("returns zeroed aggregates on empty input", async () => {
    const client = fakeClient([]);
    const result = await verificationRejectionRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toHaveLength(0);
    expect(result.aggregates["overallRejectionRateBps"]).toBe(0);
  });
});

describe("verificationRejectionRateReport — query shape", () => {
  it("groups by (stage, decision), filters window + optional stages", async () => {
    const client = fakeClient([]);
    await verificationRejectionRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, stages: [VerificationStage.PV1] }
    );
    const callArgs = client.verificationRecord.groupBy.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callArgs[0] as { by: ReadonlyArray<string>; where: Record<string, unknown> };
    expect(call.by).toEqual(["stage", "decision"]);
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["occurredAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(call.where["stage"]).toEqual({ in: [VerificationStage.PV1] });
  });
});

describe("verificationRejectionRateReport — schema", () => {
  it("rejects from > to", () => {
    expect(
      verificationRejectionRateReport.parametersSchema.safeParse({
        from: new Date("2026-06-01"),
        to: new Date("2026-05-01"),
      }).success
    ).toBe(false);
  });
});
