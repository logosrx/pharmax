// Domain-level test for reporting.* event definitions.
//
// These rules pin the reporting-domain contract:
//
//   - name starts with "reporting." — the domain prefix is the
//     CANONICAL form for this folder. Sibling events that emit
//     a different prefix (e.g. "report.*") are an inconsistency
//     fail; the rename is the right fix, not adjusting this test.
//   - owner = "reporting" — on-call rotation routes reporting events
//     to the analytics/reporting team (vs. application teams).
//   - retention = "7y" — the report_run + report_schedule ledgers
//     are SOC 2 evidence ("which operator ran which report when,
//     with which filters; who scheduled what to fire when") and
//     the matching outbox event must survive the same audit window
//     in hot or archival storage.
//   - phiSafe = true — today's report aggregates are scalar
//     counters and schedule metadata; a PHI-bearing aggregate is a
//     per-event review + schema redesign moment, not a flag flip.
//   - routingKey = "tenant.reporting" — outbox drainer fan-out
//     pairs every reporting.* event onto the tenant-reporting
//     queue; a drift here would silently mis-route events into the
//     wrong consumer pool.
//
// If any reporting event violates these invariants, the failure
// here stops merge and points the author at the relevant policy
// doc.

import { describe, expect, it } from "vitest";

import * as ReportingEvents from "./index.js";

// Count is asserted exactly so adding a new reporting event is a
// FORCED touch of this test (which forces the contributor to think
// about whether the invariants still hold for the new event). When
// you add a new reporting event, bump EXPECTED_COUNT and confirm
// the per-event assertions still apply.
const EXPECTED_COUNT = 4;

const ALL = Object.values(ReportingEvents);

describe("reporting domain barrel", () => {
  it(`exactly ${EXPECTED_COUNT} reporting.* events are registered`, () => {
    expect(ALL.length).toBe(EXPECTED_COUNT);
  });

  it("every event has a name starting with `reporting.`", () => {
    for (const def of ALL) {
      expect(def.fullName, `${def.fullName} name prefix`).toMatch(/^reporting\./);
    }
  });

  it("every reporting.* event is owned by `reporting`", () => {
    for (const def of ALL) {
      expect(def.owner, `${def.fullName} owner`).toBe("reporting");
    }
  });

  it("every reporting.* event is PHI-free", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(true);
    }
  });

  it("every reporting.* event has 7y retention", () => {
    for (const def of ALL) {
      expect(def.retention, `${def.fullName} retention`).toBe("7y");
    }
  });

  it("every reporting.* event routes via `tenant.reporting`", () => {
    for (const def of ALL) {
      expect(def.routingKey, `${def.fullName} routingKey`).toBe("tenant.reporting");
    }
  });
});
