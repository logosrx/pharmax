// scripts/operations/chaos-drill-evidence.ts
//
// Pure composers for chaos-drill evidence artifacts, mirroring the
// restore-drill split (`restore-drill-evidence.ts`): composers are
// pure (no IO, no DB), the CLI shell in `run-chaos-drill.ts`
// orchestrates IO and feeds a frozen record at the end.
//
// A chaos drill deliberately injects one production-shaped failure
// into STAGING — printer unreachable, worker paused under load,
// Stripe unavailable — and proves the system degrades the way the
// design says it does: failures are loud, queues back up without
// data loss, and recovery is automatic once the fault clears. The
// scenario procedures live in docs/operations/chaos-drills.md; the
// artifacts composed here are the SOC 2 / availability evidence
// (CC7.4 incident response exercised, A1.2 resilience).
//
// PHI: snapshots carry table names, status labels, and counts only.
// Never row payloads.

export type ChaosScenario = "printer-outage" | "queue-backpressure" | "stripe-outage";

export const CHAOS_SCENARIOS: ReadonlyArray<ChaosScenario> = Object.freeze([
  "printer-outage",
  "queue-backpressure",
  "stripe-outage",
]);

export function isChaosScenario(s: string): s is ChaosScenario {
  return (CHAOS_SCENARIOS as ReadonlyArray<string>).includes(s);
}

export function scenarioTitle(scenario: ChaosScenario): string {
  switch (scenario) {
    case "printer-outage":
      return "Printer outage (Zebra unreachable during vial-label print)";
    case "queue-backpressure":
      return "Queue backpressure (outbox backlog under paused worker)";
    case "stripe-outage":
      return "Stripe outage (invoice push during provider unavailability)";
    default: {
      const exhaustive: never = scenario;
      throw new Error(`Unhandled scenario: ${String(exhaustive)}`);
    }
  }
}

/** One (status, count) pair from a queue-table GROUP BY. */
export interface StatusCount {
  readonly status: string;
  readonly count: number;
}

export type SnapshotTable =
  | "event_outbox"
  | "webhook_delivery"
  | "print_job"
  | "stripe_webhook_event";

export interface QueueTableSnapshot {
  readonly table: SnapshotTable;
  readonly byStatus: ReadonlyArray<StatusCount>;
  /**
   * Age (seconds) of the OLDEST row still in a non-terminal status,
   * or null when no such row exists. This is the drill's headline
   * backlog number: it grows while the fault is injected and must
   * shrink back toward zero after recovery.
   */
  readonly oldestNonTerminalAgeSeconds: number | null;
}

export interface ChaosSnapshot {
  /** Operator label: conventionally baseline | during | recovery. */
  readonly label: string;
  readonly capturedAtIso: string;
  readonly tables: ReadonlyArray<QueueTableSnapshot>;
}

/** A pass/fail line against the scenario's success criteria. */
export interface SuccessCheck {
  readonly pass: boolean;
  readonly description: string;
}

export interface ChaosDrillRecord {
  readonly scenario: ChaosScenario;
  readonly period: string; // e.g. "2026-Q3"
  readonly environment: string; // e.g. "staging"
  readonly captain: string;
  readonly observer: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string | null;
  /** What the drill set out to prove, in one or two sentences. */
  readonly hypothesis: string;
  /** How the fault was injected (exact knob, host, env var…). */
  readonly injection: string;
  /** How the fault was cleared. */
  readonly recovery: string;
  readonly snapshots: ReadonlyArray<ChaosSnapshot>;
  readonly checks: ReadonlyArray<SuccessCheck>;
  readonly findings: ReadonlyArray<string>;
  readonly signOff: string | null;
}

export function composeChaosEvidenceJson(record: ChaosDrillRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Compose the evidence document for a completed chaos drill. Matches
 * the template in docs/operations/chaos-drills.md § Evidence so an
 * auditor can diff template-vs-artifact field by field.
 */
export function composeChaosEvidenceMarkdown(record: ChaosDrillRecord): string {
  const lines: string[] = [];
  lines.push(`CHAOS DRILL — ${scenarioTitle(record.scenario)} — ${record.period}`);
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`Environment: ${record.environment}`);
  lines.push(`Captain:     ${record.captain}`);
  lines.push(`Observer:    ${record.observer}`);
  lines.push(`Started:     ${record.startedAtIso}`);
  lines.push(`Completed:   ${record.completedAtIso ?? "<in flight>"}`);
  lines.push("");

  lines.push("§1. Hypothesis");
  lines.push(record.hypothesis);
  lines.push("");

  lines.push("§2. Fault injection");
  lines.push(`- Injected: ${record.injection}`);
  lines.push(`- Cleared:  ${record.recovery}`);
  lines.push("");

  lines.push("§3. Queue snapshots");
  if (record.snapshots.length === 0) {
    lines.push("- none captured");
  }
  for (const snapshot of record.snapshots) {
    lines.push(`- ${snapshot.label} @ ${snapshot.capturedAtIso}`);
    for (const table of snapshot.tables) {
      const statuses =
        table.byStatus.length === 0
          ? "empty"
          : table.byStatus.map((s) => `${s.status}=${s.count}`).join(", ");
      const age =
        table.oldestNonTerminalAgeSeconds === null
          ? "no non-terminal rows"
          : `oldest non-terminal ${formatAge(table.oldestNonTerminalAgeSeconds)}`;
      lines.push(`  - ${table.table}: ${statuses} (${age})`);
    }
  }
  lines.push("");

  lines.push("§4. Success criteria");
  if (record.checks.length === 0) {
    lines.push("- none recorded");
  }
  for (const check of record.checks) {
    lines.push(`- ${check.pass ? "PASS" : "FAIL"}: ${check.description}`);
  }
  lines.push("");

  lines.push("§5. Findings");
  if (record.findings.length === 0) {
    lines.push("- none");
  }
  for (const finding of record.findings) {
    lines.push(`- ${finding}`);
  }
  lines.push("");

  lines.push("§6. Sign-off");
  lines.push(record.signOff ?? "- pending");
  lines.push("");

  return lines.join("\n");
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
