// One check, its run history, and its exceptions.
//
// Findings live inside the run's digested `details` payload rather
// than in their own column (so that editing a finding changes the
// digest). Reading them back therefore means parsing untyped JSON,
// which is done defensively below: a details payload whose shape we
// do not recognise renders as "no parsable findings" rather than
// throwing, because the summary and digest are still valid evidence
// and a page that 500s on one malformed historical row is worse than
// one that degrades.

import "server-only";

import type {
  ComplianceCadence,
  ComplianceCheckOutcome,
  ComplianceCheckSeverity,
} from "@pharmax/database";

import { readCompliance } from "./read-context.js";

export interface CheckFinding {
  readonly subject: string;
  readonly detail: string;
}

export interface CheckRunRow {
  readonly runId: string;
  readonly outcome: ComplianceCheckOutcome;
  readonly severityAtRun: ComplianceCheckSeverity;
  readonly summary: string;
  readonly subjectOrganizationId: string | null;
  readonly findingCount: number;
  readonly findings: ReadonlyArray<CheckFinding>;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly digestSha256: string;
  readonly observedAt: Date;
  readonly durationMs: number;
}

export interface CheckExceptionRow {
  readonly exceptionId: string;
  readonly reasonCode: string;
  readonly justification: string;
  readonly subjectOrganizationId: string | null;
  readonly approvedByDisplayName: string | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  /** Computed against the request clock, not stored. */
  readonly active: boolean;
}

export interface CheckDetail {
  readonly checkId: string;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly severity: ComplianceCheckSeverity;
  readonly cadence: ComplianceCadence;
  readonly intervalMinutes: number | null;
  readonly enabled: boolean;
  readonly automated: boolean;
  readonly lastOutcome: ComplianceCheckOutcome | null;
  readonly lastRunAt: Date | null;
  readonly nextRunAt: Date | null;
  readonly consecutiveFailureCount: number;
  readonly controls: ReadonlyArray<{
    readonly controlId: string;
    readonly code: string;
    readonly title: string;
  }>;
  readonly runs: ReadonlyArray<CheckRunRow>;
  readonly exceptions: ReadonlyArray<CheckExceptionRow>;
}

const RUN_HISTORY_LIMIT = 30;
const EXCEPTION_LIMIT = 20;
/** Per-run cap; a 4,000-finding FAIL must not render 4,000 rows. */
const FINDINGS_PER_RUN_LIMIT = 50;

function parseFindings(details: unknown): ReadonlyArray<CheckFinding> {
  if (typeof details !== "object" || details === null) return [];
  const raw = (details as Record<string, unknown>)["findings"];
  if (!Array.isArray(raw)) return [];

  const out: CheckFinding[] = [];
  for (const entry of raw.slice(0, FINDINGS_PER_RUN_LIMIT)) {
    if (typeof entry !== "object" || entry === null) continue;
    const subject = (entry as Record<string, unknown>)["subject"];
    const detail = (entry as Record<string, unknown>)["detail"];
    if (typeof subject !== "string" || typeof detail !== "string") continue;
    out.push(Object.freeze({ subject, detail }));
  }
  return Object.freeze(out);
}

export async function getComplianceCheckDetail(options: {
  readonly checkId: string;
  readonly now: Date;
}): Promise<CheckDetail | null> {
  return readCompliance("check-detail", async (tx) => {
    const row = await tx.complianceCheck.findUnique({
      where: { id: options.checkId },
      select: {
        id: true,
        code: true,
        title: true,
        description: true,
        severity: true,
        cadence: true,
        intervalMinutes: true,
        enabled: true,
        automated: true,
        lastOutcome: true,
        lastRunAt: true,
        nextRunAt: true,
        consecutiveFailureCount: true,
        controls: {
          select: { control: { select: { id: true, code: true, title: true } } },
        },
        runs: {
          select: {
            id: true,
            outcome: true,
            severityAtRun: true,
            summary: true,
            subjectOrganizationId: true,
            findingCount: true,
            details: true,
            errorCode: true,
            errorMessage: true,
            digestSha256: true,
            observedAt: true,
            durationMs: true,
          },
          orderBy: { observedAt: "desc" },
          take: RUN_HISTORY_LIMIT,
        },
        exceptions: {
          select: {
            id: true,
            reasonCode: true,
            justification: true,
            subjectOrganizationId: true,
            approvedByUser: { select: { displayName: true } },
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: EXCEPTION_LIMIT,
        },
      },
    });

    if (row === null) return null;

    return Object.freeze({
      checkId: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      severity: row.severity,
      cadence: row.cadence,
      intervalMinutes: row.intervalMinutes,
      enabled: row.enabled,
      automated: row.automated,
      lastOutcome: row.lastOutcome,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      consecutiveFailureCount: row.consecutiveFailureCount,
      controls: Object.freeze(
        row.controls
          .map((c) =>
            Object.freeze({
              controlId: c.control.id,
              code: c.control.code,
              title: c.control.title,
            })
          )
          .sort((a, b) => a.code.localeCompare(b.code))
      ),
      runs: Object.freeze(
        row.runs.map((r) =>
          Object.freeze({
            runId: r.id,
            outcome: r.outcome,
            severityAtRun: r.severityAtRun,
            summary: r.summary,
            subjectOrganizationId: r.subjectOrganizationId,
            findingCount: r.findingCount,
            findings: parseFindings(r.details),
            errorCode: r.errorCode,
            errorMessage: r.errorMessage,
            digestSha256: r.digestSha256,
            observedAt: r.observedAt,
            durationMs: r.durationMs,
          })
        )
      ),
      exceptions: Object.freeze(
        row.exceptions.map((e) =>
          Object.freeze({
            exceptionId: e.id,
            reasonCode: e.reasonCode,
            justification: e.justification,
            subjectOrganizationId: e.subjectOrganizationId,
            approvedByDisplayName: e.approvedByUser?.displayName ?? null,
            expiresAt: e.expiresAt,
            revokedAt: e.revokedAt,
            createdAt: e.createdAt,
            active: e.revokedAt === null && e.expiresAt.getTime() > options.now.getTime(),
          })
        )
      ),
    });
  });
}
