// The canonical UI vocabulary for compliance state.
//
// Mirrors src/components/ui/workflow.ts for the compliance plane, so
// the posture pages speak the same visual language as the order
// queues: amber means "someone should look", red means "this is
// broken", green means "verified".
//
// Two mappings here are opinions, not translations, and both exist to
// stop the dashboard from flattering us:
//
//   ERROR is amber, not green and not red. A probe that could not
//   reach a verdict has told us nothing about the control. Rendering
//   it as a pass would be a lie; rendering it as a failure would cry
//   wolf about a control that may well be fine. It is an
//   observability gap and it looks like one.
//
//   A null outcome — never run — is amber too, never neutral grey. A
//   check that has never produced evidence is indistinguishable from
//   a check that does not exist, and greying it out is how it stays
//   invisible for a year.

import type {
  ComplianceCadence,
  ComplianceCheckOutcome,
  ComplianceCheckSeverity,
  ComplianceControlStatus,
  ComplianceFramework,
  ComplianceTaskStatus,
} from "@pharmax/database";

import type { Tone } from "../ui/badge.js";

export interface Meta {
  readonly label: string;
  readonly tone: Tone;
}

export const OUTCOME_META: Record<ComplianceCheckOutcome, Meta> = {
  PASS: { label: "Pass", tone: "success" },
  FAIL: { label: "Fail", tone: "danger" },
  ERROR: { label: "Error", tone: "warning" },
  NOT_APPLICABLE: { label: "N/A", tone: "neutral" },
};

/** Outcome badge copy for a check that has never run. */
export const NEVER_RUN_META: Meta = { label: "Never run", tone: "warning" };

export function outcomeMeta(outcome: ComplianceCheckOutcome | null): Meta {
  return outcome === null ? NEVER_RUN_META : OUTCOME_META[outcome];
}

export const SEVERITY_META: Record<ComplianceCheckSeverity, Meta> = {
  CRITICAL: { label: "Critical", tone: "danger" },
  HIGH: { label: "High", tone: "warning" },
  MEDIUM: { label: "Medium", tone: "info" },
  LOW: { label: "Low", tone: "neutral" },
};

export const CONTROL_STATUS_META: Record<ComplianceControlStatus, Meta> = {
  IMPLEMENTED: { label: "Implemented", tone: "success" },
  PARTIAL: { label: "Partial", tone: "warning" },
  PLANNED: { label: "Planned", tone: "info" },
  DEPRECATED: { label: "Deprecated", tone: "neutral" },
  NOT_APPLICABLE: { label: "Not applicable", tone: "neutral" },
};

export const TASK_STATUS_META: Record<ComplianceTaskStatus, Meta> = {
  OPEN: { label: "Open", tone: "info" },
  IN_PROGRESS: { label: "In progress", tone: "brand" },
  BLOCKED: { label: "Blocked", tone: "danger" },
  DONE: { label: "Done", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const CADENCE_LABEL: Record<ComplianceCadence, string> = {
  CONTINUOUS: "Continuous",
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
  ON_CHANGE: "On change",
  PER_EVENT: "Per event",
};

export const FRAMEWORK_LABEL: Record<ComplianceFramework, string> = {
  SOC2_TSC: "SOC 2 (Trust Services Criteria)",
  HIPAA_SECURITY: "HIPAA Security Rule",
  HIPAA_PRIVACY: "HIPAA Privacy Rule",
  HIPAA_BREACH: "HIPAA Breach Notification",
};

export const FRAMEWORK_SHORT_LABEL: Record<ComplianceFramework, string> = {
  SOC2_TSC: "SOC 2",
  HIPAA_SECURITY: "HIPAA Security",
  HIPAA_PRIVACY: "HIPAA Privacy",
  HIPAA_BREACH: "HIPAA Breach",
};

/** `2026-08-03 14:22Z` — compact, unambiguous, sortable. */
export function formatInstant(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

export function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * "3 days ago" / "in 4 hours". Rendered beside an absolute timestamp,
 * never instead of one — relative time is easier to scan but useless
 * in an audit transcript.
 */
export function formatRelative(target: Date, now: Date): string {
  const deltaMs = target.getTime() - now.getTime();
  const future = deltaMs > 0;
  const abs = Math.abs(deltaMs);

  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;

  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}
