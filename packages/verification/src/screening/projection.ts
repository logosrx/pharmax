// The screening result, projected for an event payload.
//
// WHY THE PAYLOAD IS NOT THE WHOLE FINDING. `ScreeningFinding` is
// designed to be persistable verbatim, and it is — into
// `order_screening_finding`, which is behind RLS and read inside an
// authorized session. An outbox payload is a wider surface: it fans
// out to webhook subscribers, sits in a dead-letter queue, and gets
// pasted into a support ticket. So the event carries the finding's
// IDENTITY and GRADING (code, kind, severity, certainty, disposition,
// fingerprint) and drops `reason`, `triggers` and `citation`. A
// consumer that needs the sentence reads the row.
//
// The counts are what a consumer usually wants anyway: an SLA or
// quality dashboard asks "how many orders hit an acknowledge-tier
// finding this week", not "what did finding #3 say".
//
// `gapCount` is called out separately rather than folded into the
// totals because it answers a different question from the rest —
// not "how risky is this prescription" but "how much of the screen
// actually ran". With no licensed knowledge source wired, every
// order reports a gap, and a dashboard that cannot see that will
// report a fleet of successfully-screened prescriptions.

import type { ScreeningEvaluation, ScreeningFinding } from "@pharmax/clinical-screening";

export interface ProjectedFinding {
  readonly code: string;
  readonly kind: string;
  readonly severity: string;
  readonly certainty: string;
  readonly disposition: string;
  readonly fingerprint: string;
}

export interface ProjectedScreening {
  readonly outcome: string;
  readonly findingCount: number;
  readonly hardStopCount: number;
  readonly requiresAcknowledgementCount: number;
  readonly informationalCount: number;
  /** Findings of kind `SCREENING_GAP`: checks that could NOT be run. */
  readonly gapCount: number;
  readonly findings: ReadonlyArray<ProjectedFinding>;
}

export function projectScreening(evaluation: ScreeningEvaluation): ProjectedScreening {
  const findings: ReadonlyArray<ScreeningFinding> = evaluation.findings;
  return {
    outcome: evaluation.outcome,
    findingCount: findings.length,
    hardStopCount: findings.filter((f) => f.disposition === "HARD_STOP").length,
    requiresAcknowledgementCount: findings.filter(
      (f) => f.disposition === "REQUIRES_ACKNOWLEDGEMENT"
    ).length,
    informationalCount: findings.filter((f) => f.disposition === "INFORMATIONAL").length,
    gapCount: findings.filter((f) => f.kind === "SCREENING_GAP").length,
    findings: findings.map((f) => ({
      code: f.code,
      kind: f.kind,
      severity: f.severity,
      certainty: f.certainty,
      disposition: f.disposition,
      fingerprint: f.fingerprint,
    })),
  };
}
