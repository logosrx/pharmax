// Unit tests for the access-review anomaly detector. Pure
// functions; the input is a fixture aggregate.

import { describe, expect, it } from "vitest";

import type { AccessActivityAggregate } from "./access-activity-aggregator.js";
import { DEFAULT_THRESHOLDS, detectAccessAnomalies } from "./access-review-anomaly-detector.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_A = "00000000-0000-4000-8000-0000000000aa";
const ACTOR_B = "00000000-0000-4000-8000-0000000000bb";

function fixtureAggregate(partial?: Partial<AccessActivityAggregate>): AccessActivityAggregate {
  return {
    organizationId: ORG_ID,
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-04-01T00:00:00.000Z",
    commandCounts: [],
    auditCounts: [],
    totals: { commandRows: 0, auditRows: 0, distinctOperators: 0 },
    ...partial,
  };
}

describe("detectAccessAnomalies", () => {
  it("returns empty list on empty aggregate", () => {
    const out = detectAccessAnomalies({ aggregate: fixtureAggregate() });
    expect(out).toEqual([]);
  });

  it("flags Pharmacist approving 60 invoices (over the per-command threshold)", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "ApproveInvoice",
            actorUserId: ACTOR_A,
            count: 60,
            successes: 60,
            failures: 0,
          },
        ],
      }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("high-command-volume");
    expect(out[0]?.actorUserId).toBe(ACTOR_A);
    expect(out[0]?.label).toBe("ApproveInvoice");
  });

  it("does not flag below the threshold", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "ApproveInvoice",
            actorUserId: ACTOR_A,
            count: 40,
            successes: 40,
            failures: 0,
          },
        ],
      }),
    });
    expect(out).toEqual([]);
  });

  it("flags high-failure-ratio when 5+ attempts and ≥50% fail", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "StartTyping",
            actorUserId: ACTOR_A,
            count: 8,
            successes: 3,
            failures: 5,
          },
        ],
      }),
    });
    expect(out.some((a) => a.kind === "high-failure-ratio")).toBe(true);
  });

  it("ignores failure ratio below threshold attempts", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "StartTyping",
            actorUserId: ACTOR_A,
            count: 3,
            successes: 1,
            failures: 2,
          },
        ],
      }),
    });
    expect(out.some((a) => a.kind === "high-failure-ratio")).toBe(false);
  });

  it("flags a patient.view audit-action threshold breach", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        auditCounts: [{ action: "patient.view", actorUserId: ACTOR_B, count: 250 }],
      }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("high-audit-action-volume");
    expect(out[0]?.actorUserId).toBe(ACTOR_B);
  });

  it("flags any BREAK_GLASS_SESSION_OPENED above 3", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        auditCounts: [{ action: "BREAK_GLASS_SESSION_OPENED", actorUserId: ACTOR_A, count: 4 }],
      }),
    });
    expect(out.some((a) => a.label === "BREAK_GLASS_SESSION_OPENED")).toBe(true);
  });

  it("flags an elevated role with zero activity", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "StartTyping",
            actorUserId: ACTOR_A,
            count: 5,
            successes: 5,
            failures: 0,
          },
        ],
      }),
      elevatedActorUserIds: [ACTOR_A, ACTOR_B],
    });
    const lowActivity = out.filter((a) => a.kind === "elevated-role-low-activity");
    expect(lowActivity).toHaveLength(1);
    expect(lowActivity[0]?.actorUserId).toBe(ACTOR_B);
  });

  it("respects an override threshold", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "ApproveInvoice",
            actorUserId: ACTOR_A,
            count: 100,
            successes: 100,
            failures: 0,
          },
        ],
      }),
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        commandSpecificThresholds: { ApproveInvoice: 1000 },
      },
    });
    expect(out).toEqual([]);
  });

  it("returns anomalies in stable order", () => {
    const out = detectAccessAnomalies({
      aggregate: fixtureAggregate({
        commandCounts: [
          {
            commandName: "ZuluCmd",
            actorUserId: ACTOR_B,
            count: 100,
            successes: 100,
            failures: 0,
          },
          {
            commandName: "AlphaCmd",
            actorUserId: ACTOR_A,
            count: 100,
            successes: 100,
            failures: 0,
          },
        ],
      }),
    });
    expect(out.map((a) => a.label)).toEqual(["AlphaCmd", "ZuluCmd"]);
  });
});
