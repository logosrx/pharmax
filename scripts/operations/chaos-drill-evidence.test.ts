import { describe, expect, it } from "vitest";

import {
  composeChaosEvidenceJson,
  composeChaosEvidenceMarkdown,
  isChaosScenario,
  scenarioTitle,
  CHAOS_SCENARIOS,
  type ChaosDrillRecord,
} from "./chaos-drill-evidence.js";

function baseRecord(overrides: Partial<ChaosDrillRecord> = {}): ChaosDrillRecord {
  return {
    scenario: "printer-outage",
    period: "2026-Q3",
    environment: "staging",
    captain: "R. Captain",
    observer: "O. Observer",
    startedAtIso: "2026-07-31T14:00:00.000Z",
    completedAtIso: "2026-07-31T15:30:00.000Z",
    hypothesis: "A dead printer fails loudly and never records a phantom label.",
    injection: "LabelPrinter host pointed at 10.0.0.254:9100 (blackhole).",
    recovery: "Printer host restored to the staging Zebra bridge.",
    snapshots: [
      {
        label: "baseline",
        capturedAtIso: "2026-07-31T14:00:00.000Z",
        tables: [
          {
            table: "print_job",
            byStatus: [
              { status: "COMPLETED", count: 42 },
              { status: "SENT", count: 0 },
            ],
            oldestNonTerminalAgeSeconds: null,
          },
        ],
      },
      {
        label: "during",
        capturedAtIso: "2026-07-31T14:20:00.000Z",
        tables: [
          {
            table: "print_job",
            byStatus: [
              { status: "FAILED", count: 3 },
              { status: "SENT", count: 1 },
            ],
            oldestNonTerminalAgeSeconds: 754,
          },
        ],
      },
    ],
    checks: [
      { pass: true, description: "Every failed print produced a FAILED print_job with reason" },
      { pass: false, description: "Operator UI showed the printer-down banner within 60s" },
    ],
    findings: ["Printer-down banner lagged ~3 minutes; UI polls too slowly."],
    signOff: "Drill complete; one finding filed.",
    ...overrides,
  };
}

describe("scenario helpers", () => {
  it("accepts exactly the three drill scenarios", () => {
    for (const s of CHAOS_SCENARIOS) {
      expect(isChaosScenario(s)).toBe(true);
    }
    expect(isChaosScenario("meteor-strike")).toBe(false);
  });

  it("titles every scenario", () => {
    for (const s of CHAOS_SCENARIOS) {
      expect(scenarioTitle(s).length).toBeGreaterThan(10);
    }
  });
});

describe("composeChaosEvidenceMarkdown", () => {
  it("renders every template section with the drill data", () => {
    const md = composeChaosEvidenceMarkdown(baseRecord());
    expect(md).toContain("CHAOS DRILL — Printer outage");
    expect(md).toContain("2026-Q3");
    expect(md).toContain("Environment: staging");
    expect(md).toContain("§1. Hypothesis");
    expect(md).toContain("phantom label");
    expect(md).toContain("§2. Fault injection");
    expect(md).toContain("10.0.0.254:9100");
    expect(md).toContain("§3. Queue snapshots");
    expect(md).toContain("baseline @ 2026-07-31T14:00:00.000Z");
    expect(md).toContain("print_job: COMPLETED=42, SENT=0 (no non-terminal rows)");
    expect(md).toContain("print_job: FAILED=3, SENT=1 (oldest non-terminal 13m)");
    expect(md).toContain("§4. Success criteria");
    expect(md).toContain("- PASS: Every failed print");
    expect(md).toContain("- FAIL: Operator UI showed");
    expect(md).toContain("§5. Findings");
    expect(md).toContain("banner lagged");
    expect(md).toContain("§6. Sign-off");
    expect(md).toContain("one finding filed");
  });

  it("handles an in-flight drill with nothing captured yet", () => {
    const md = composeChaosEvidenceMarkdown(
      baseRecord({
        completedAtIso: null,
        snapshots: [],
        checks: [],
        findings: [],
        signOff: null,
      })
    );
    expect(md).toContain("Completed:   <in flight>");
    expect(md).toContain("- none captured");
    expect(md).toContain("- none recorded");
    expect(md).toContain("§5. Findings\n- none");
    expect(md).toContain("§6. Sign-off\n- pending");
  });

  it("formats backlog ages in s / m / h", () => {
    const snapshotAt = (age: number) => ({
      label: "during",
      capturedAtIso: "2026-07-31T14:20:00.000Z",
      tables: [
        {
          table: "event_outbox" as const,
          byStatus: [{ status: "PENDING", count: 1 }],
          oldestNonTerminalAgeSeconds: age,
        },
      ],
    });
    expect(composeChaosEvidenceMarkdown(baseRecord({ snapshots: [snapshotAt(30)] }))).toContain(
      "oldest non-terminal 30s"
    );
    expect(composeChaosEvidenceMarkdown(baseRecord({ snapshots: [snapshotAt(600)] }))).toContain(
      "oldest non-terminal 10m"
    );
    expect(composeChaosEvidenceMarkdown(baseRecord({ snapshots: [snapshotAt(9000)] }))).toContain(
      "oldest non-terminal 2.5h"
    );
  });
});

describe("composeChaosEvidenceJson", () => {
  it("round-trips the record", () => {
    const record = baseRecord();
    const parsed = JSON.parse(composeChaosEvidenceJson(record)) as ChaosDrillRecord;
    expect(parsed).toEqual(record);
  });
});
