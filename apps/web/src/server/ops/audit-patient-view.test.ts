// partitionAuditedPatients: the one place that decides what an audit
// failure withholds from a search surface (issue #79).
//
// The invariant under test: a row appears in `visible` if and only if
// its patientId is NOT in the batch's failedPatientIds — no rescue
// paths, no "show it anyway with a warning" escape hatch. A null
// batch (audit never attempted) withholds everything.
//
// CLEAN ROOM / PHI: synthetic ids only; rows carry no identity fields.

import { describe, expect, it } from "vitest";

import {
  partitionAuditedPatients,
  type BatchAuditPatientViewResult,
} from "./audit-patient-view.js";

function row(patientId: string): { readonly patientId: string; readonly label: string } {
  return { patientId, label: `row-${patientId}` };
}

function batchWithFailures(
  attempted: number,
  failedPatientIds: ReadonlyArray<string>
): BatchAuditPatientViewResult {
  return {
    attempted,
    succeeded: attempted - failedPatientIds.length,
    failedPatientIds,
  };
}

const ROWS = [row("p1"), row("p2"), row("p3")];

describe("partitionAuditedPatients", () => {
  it("passes every row through when every audit succeeded", () => {
    const result = partitionAuditedPatients(ROWS, batchWithFailures(3, []));
    expect(result.visible).toEqual(ROWS);
    expect(result.suppressedCount).toBe(0);
  });

  it("withholds exactly the rows whose audit failed, preserving order", () => {
    const result = partitionAuditedPatients(ROWS, batchWithFailures(3, ["p2"]));
    expect(result.visible.map((r) => r.patientId)).toEqual(["p1", "p3"]);
    expect(result.suppressedCount).toBe(1);
  });

  it("withholds everything when every audit failed", () => {
    const result = partitionAuditedPatients(ROWS, batchWithFailures(3, ["p1", "p2", "p3"]));
    expect(result.visible).toEqual([]);
    expect(result.suppressedCount).toBe(3);
  });

  it("withholds everything when no audit was attempted (null batch)", () => {
    const result = partitionAuditedPatients(ROWS, null);
    expect(result.visible).toEqual([]);
    expect(result.suppressedCount).toBe(3);
  });

  it("handles the empty result set", () => {
    const result = partitionAuditedPatients([], batchWithFailures(0, []));
    expect(result.visible).toEqual([]);
    expect(result.suppressedCount).toBe(0);
  });
});
