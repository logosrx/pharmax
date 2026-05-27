// Access-review anomaly detector.
//
// Given an `AccessActivityAggregate` (counts only, no PHI), surface
// patterns that warrant reviewer attention. The intent is NOT to
// auto-classify a finding — that is the human reviewer's call.
// This module produces a list of "look at this row" hints with
// a stable, machine-readable `kind`, an `actorUserId` for the
// reviewer to follow up on, and a short, PHI-free `message`.
//
// All thresholds are configurable so the audit team can tune
// without re-deploying — the defaults are picked from the
// access-review procedure's experience-based heuristics.

import type { AccessActivityAggregate } from "./access-activity-aggregator.js";

export interface AnomalyDetectionThresholds {
  /**
   * If an actor's command count for a single command exceeds this,
   * surface it (default 50). The threshold is uniform; per-command
   * tuning lives in `commandSpecificThresholds`.
   */
  readonly highCommandVolumePerActor: number;
  /** Override the default for specific command names. */
  readonly commandSpecificThresholds?: Readonly<Record<string, number>>;
  /**
   * Threshold for "high failure ratio" — `failures / count` ≥ this
   * AND `count` ≥ `highFailureRatioMinAttempts`. Default 0.5 + 5.
   */
  readonly highFailureRatio: number;
  readonly highFailureRatioMinAttempts: number;
  /**
   * Audit-action volume that warrants a hint (default 100). For
   * sensitive actions an override is recommended.
   */
  readonly highAuditActionVolumePerActor: number;
  /** Override the default per audit action. */
  readonly auditActionSpecificThresholds?: Readonly<Record<string, number>>;
}

export const DEFAULT_THRESHOLDS: AnomalyDetectionThresholds = Object.freeze({
  highCommandVolumePerActor: 50,
  commandSpecificThresholds: Object.freeze({
    // Approving 50+ invoices in a quarter is plausible for a
    // BillingManager but worth flagging for any other role.
    ApproveInvoice: 50,
    // PV1 / final-verification approvals at 200+/quarter are
    // worth a sanity check.
    ApprovePV1: 200,
    ApproveFinalVerification: 200,
    // Crypto-shred is rare; even one is worth a look.
    CryptoShredPatient: 1,
  }),
  highFailureRatio: 0.5,
  highFailureRatioMinAttempts: 5,
  highAuditActionVolumePerActor: 100,
  auditActionSpecificThresholds: Object.freeze({
    // PHI reads, by aggregate count, are a sensitive signal even
    // though we don't see the rows themselves.
    "patient.view": 200,
    // Break-glass opens — any single actor opening multiple in a
    // quarter is unusual.
    BREAK_GLASS_SESSION_OPENED: 3,
  }),
});

export interface AccessAnomaly {
  readonly kind:
    | "high-command-volume"
    | "high-failure-ratio"
    | "high-audit-action-volume"
    | "elevated-role-low-activity";
  /** The actor the reviewer should follow up on. NULL = system actor. */
  readonly actorUserId: string | null;
  /** Short label of the trigger (command name, action name, etc.). */
  readonly label: string;
  /** Concrete numbers for the row, so the reviewer can re-pivot. */
  readonly count: number;
  /** Free-form, PHI-free human-readable summary. ≤ 200 chars. */
  readonly message: string;
}

export interface DetectAnomaliesInput {
  readonly aggregate: AccessActivityAggregate;
  readonly elevatedActorUserIds?: ReadonlyArray<string>;
  readonly thresholds?: AnomalyDetectionThresholds;
}

/**
 * Pure function: walk the aggregate, return a sorted list of
 * anomalies. Stable ordering so byte-identical re-runs produce
 * identical evidence artifacts.
 */
export function detectAccessAnomalies(input: DetectAnomaliesInput): ReadonlyArray<AccessAnomaly> {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const out: AccessAnomaly[] = [];

  for (const row of input.aggregate.commandCounts) {
    const ceiling =
      thresholds.commandSpecificThresholds?.[row.commandName] ??
      thresholds.highCommandVolumePerActor;
    if (row.count > ceiling) {
      out.push({
        kind: "high-command-volume",
        actorUserId: row.actorUserId,
        label: row.commandName,
        count: row.count,
        message: `Actor ran ${String(row.count)}x ${row.commandName} this quarter (threshold ${String(ceiling)}). Confirm role still appropriate.`,
      });
    }
    if (
      row.count >= thresholds.highFailureRatioMinAttempts &&
      row.failures / row.count >= thresholds.highFailureRatio
    ) {
      out.push({
        kind: "high-failure-ratio",
        actorUserId: row.actorUserId,
        label: row.commandName,
        count: row.count,
        message: `Actor's ${row.commandName} attempts: ${String(row.successes)} ok / ${String(row.failures)} failed of ${String(row.count)} total. Probe for credential misuse or training gap.`,
      });
    }
  }

  for (const row of input.aggregate.auditCounts) {
    const ceiling =
      thresholds.auditActionSpecificThresholds?.[row.action] ??
      thresholds.highAuditActionVolumePerActor;
    if (row.count > ceiling) {
      out.push({
        kind: "high-audit-action-volume",
        actorUserId: row.actorUserId,
        label: row.action,
        count: row.count,
        message: `Actor produced ${String(row.count)}x audit action ${row.action} (threshold ${String(ceiling)}).`,
      });
    }
  }

  if (input.elevatedActorUserIds && input.elevatedActorUserIds.length > 0) {
    const activeActors = new Set<string>();
    for (const r of input.aggregate.commandCounts) {
      if (r.actorUserId !== null) activeActors.add(r.actorUserId);
    }
    for (const r of input.aggregate.auditCounts) {
      if (r.actorUserId !== null) activeActors.add(r.actorUserId);
    }
    for (const elevated of input.elevatedActorUserIds) {
      if (!activeActors.has(elevated)) {
        out.push({
          kind: "elevated-role-low-activity",
          actorUserId: elevated,
          label: "elevated-role-no-activity",
          count: 0,
          message: `Operator holds an elevated role but produced zero command/audit activity this quarter. Confirm continued need.`,
        });
      }
    }
  }

  return out.sort(stableAnomalyOrder);
}

function stableAnomalyOrder(a: AccessAnomaly, b: AccessAnomaly): number {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  if (a.label !== b.label) return a.label.localeCompare(b.label);
  return (a.actorUserId ?? "").localeCompare(b.actorUserId ?? "");
}
