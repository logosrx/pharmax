// Posture overview — the numbers on /ops/admin/compliance.
//
// One read, assembled from grouped counts rather than row scans,
// because this page is the compliance section's landing surface and
// will be opened far more often than it changes.
//
// The framework-coverage figure counts criteria that have at least one
// control mapped to them. That is a deliberately weak claim — a mapped
// control may be PLANNED, and a mapped criterion is not a satisfied
// one — so the UI labels it "mapped", never "compliant". The honest
// version of "are we compliant with CC6.1" requires reading the
// mapped controls' statuses and their checks' outcomes, which is what
// the criterion drill-down is for. Reporting a single green percentage
// here would be the kind of number that gets screenshotted into a
// board deck and quietly becomes a claim nobody verified.

import "server-only";

import type {
  ComplianceCheckOutcome,
  ComplianceCheckSeverity,
  ComplianceControlStatus,
  ComplianceFramework,
  ComplianceTaskStatus,
} from "@pharmax/database";

import { readCompliance, type ComplianceReadTx } from "./read-context.js";

export interface ControlStatusCounts {
  readonly total: number;
  readonly byStatus: Readonly<Record<ComplianceControlStatus, number>>;
  /** Implemented controls that no human has ever attested to. */
  readonly neverSignedOff: number;
}

export interface CheckOutcomeCounts {
  readonly total: number;
  readonly enabled: number;
  readonly disabled: number;
  /** Enabled checks with no run yet — invisible, not passing. */
  readonly neverRun: number;
  readonly byOutcome: Readonly<Record<ComplianceCheckOutcome, number>>;
}

export interface TaskCounts {
  readonly open: number;
  readonly overdue: number;
}

export interface FrameworkCoverage {
  readonly framework: ComplianceFramework;
  readonly totalCriteria: number;
  readonly mappedCriteria: number;
}

/** A check that is not passing, with whatever is excusing it. */
export interface AttentionRow {
  readonly checkId: string;
  readonly code: string;
  readonly title: string;
  readonly severity: ComplianceCheckSeverity;
  readonly outcome: ComplianceCheckOutcome;
  readonly consecutiveFailureCount: number;
  readonly lastRunAt: Date | null;
  /** Non-null when an unexpired, unrevoked exception covers this. */
  readonly exceptionExpiresAt: Date | null;
}

export interface CompliancePostureOverview {
  readonly controls: ControlStatusCounts;
  readonly checks: CheckOutcomeCounts;
  readonly tasks: TaskCounts;
  readonly frameworks: ReadonlyArray<FrameworkCoverage>;
  readonly attention: ReadonlyArray<AttentionRow>;
}

const CONTROL_STATUSES: ReadonlyArray<ComplianceControlStatus> = [
  "IMPLEMENTED",
  "PARTIAL",
  "PLANNED",
  "DEPRECATED",
  "NOT_APPLICABLE",
];

const CHECK_OUTCOMES: ReadonlyArray<ComplianceCheckOutcome> = [
  "PASS",
  "FAIL",
  "ERROR",
  "NOT_APPLICABLE",
];

const SEVERITY_ORDER: Readonly<Record<ComplianceCheckSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Cap on the attention list; the full set lives on the checks page. */
const ATTENTION_LIMIT = 12;

function zeroed<K extends string>(keys: ReadonlyArray<K>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

async function loadControls(tx: ComplianceReadTx): Promise<ControlStatusCounts> {
  const [grouped, neverSignedOff] = await Promise.all([
    tx.complianceControl.groupBy({ by: ["status"], _count: { _all: true } }),
    tx.complianceControl.count({
      where: { status: { in: ["IMPLEMENTED", "PARTIAL"] }, lastSignedOffAt: null },
    }),
  ]);

  const byStatus = zeroed(CONTROL_STATUSES);
  let total = 0;
  for (const row of grouped) {
    byStatus[row.status] = row._count._all;
    total += row._count._all;
  }
  return Object.freeze({ total, byStatus: Object.freeze(byStatus), neverSignedOff });
}

async function loadChecks(tx: ComplianceReadTx): Promise<CheckOutcomeCounts> {
  const [grouped, enabled, total, neverRun] = await Promise.all([
    tx.complianceCheck.groupBy({
      by: ["lastOutcome"],
      where: { enabled: true },
      _count: { _all: true },
    }),
    tx.complianceCheck.count({ where: { enabled: true } }),
    tx.complianceCheck.count(),
    tx.complianceCheck.count({ where: { enabled: true, lastRunAt: null } }),
  ]);

  const byOutcome = zeroed(CHECK_OUTCOMES);
  for (const row of grouped) {
    // lastOutcome is null for never-run checks; those are counted
    // separately rather than folded into any outcome bucket.
    if (row.lastOutcome !== null) byOutcome[row.lastOutcome] = row._count._all;
  }

  return Object.freeze({
    total,
    enabled,
    disabled: total - enabled,
    neverRun,
    byOutcome: Object.freeze(byOutcome),
  });
}

async function loadTasks(tx: ComplianceReadTx, now: Date): Promise<TaskCounts> {
  const openStatuses: ComplianceTaskStatus[] = ["OPEN", "IN_PROGRESS", "BLOCKED"];
  const [open, overdue] = await Promise.all([
    tx.complianceTask.count({ where: { status: { in: openStatuses } } }),
    tx.complianceTask.count({ where: { status: { in: openStatuses }, dueAt: { lt: now } } }),
  ]);
  return Object.freeze({ open, overdue });
}

async function loadFrameworks(tx: ComplianceReadTx): Promise<ReadonlyArray<FrameworkCoverage>> {
  const rows = await tx.complianceCriterion.findMany({
    where: { active: true },
    select: { framework: true, _count: { select: { controls: true } } },
  });

  const totals = new Map<ComplianceFramework, { total: number; mapped: number }>();
  for (const row of rows) {
    const entry = totals.get(row.framework) ?? { total: 0, mapped: 0 };
    entry.total += 1;
    if (row._count.controls > 0) entry.mapped += 1;
    totals.set(row.framework, entry);
  }

  return Object.freeze(
    [...totals.entries()]
      .map(([framework, v]) =>
        Object.freeze({ framework, totalCriteria: v.total, mappedCriteria: v.mapped })
      )
      .sort((a, b) => a.framework.localeCompare(b.framework))
  );
}

async function loadAttention(
  tx: ComplianceReadTx,
  now: Date
): Promise<ReadonlyArray<AttentionRow>> {
  const rows = await tx.complianceCheck.findMany({
    where: { enabled: true, lastOutcome: { in: ["FAIL", "ERROR"] } },
    select: {
      id: true,
      code: true,
      title: true,
      severity: true,
      lastOutcome: true,
      lastRunAt: true,
      consecutiveFailureCount: true,
      exceptions: {
        where: { revokedAt: null, expiresAt: { gt: now } },
        select: { expiresAt: true },
        orderBy: { expiresAt: "desc" },
        take: 1,
      },
    },
    // Over-fetch relative to the display cap so the JS sort below
    // orders a superset rather than an arbitrary database-ordered
    // slice; severity is not sortable in SQL without an enum cast.
    take: ATTENTION_LIMIT * 4,
  });

  return Object.freeze(
    rows
      .map((r) =>
        Object.freeze({
          checkId: r.id,
          code: r.code,
          title: r.title,
          severity: r.severity,
          // Narrowed by the query's `in` filter; the field is
          // nullable in the schema for never-run checks.
          outcome: (r.lastOutcome ?? "FAIL") as ComplianceCheckOutcome,
          consecutiveFailureCount: r.consecutiveFailureCount,
          lastRunAt: r.lastRunAt,
          exceptionExpiresAt: r.exceptions[0]?.expiresAt ?? null,
        })
      )
      .sort((a, b) => {
        // Uncovered failures first: an accepted exception is a
        // decision already made, and burying a fresh CRITICAL under
        // three excused ones defeats the page.
        const aCovered = a.exceptionExpiresAt !== null ? 1 : 0;
        const bCovered = b.exceptionExpiresAt !== null ? 1 : 0;
        if (aCovered !== bCovered) return aCovered - bCovered;
        const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (bySeverity !== 0) return bySeverity;
        return b.consecutiveFailureCount - a.consecutiveFailureCount;
      })
      .slice(0, ATTENTION_LIMIT)
  );
}

export async function getCompliancePostureOverview(options: {
  readonly now: Date;
}): Promise<CompliancePostureOverview> {
  return readCompliance("posture-overview", async (tx) => {
    const [controls, checks, tasks, frameworks, attention] = await Promise.all([
      loadControls(tx),
      loadChecks(tx),
      loadTasks(tx, options.now),
      loadFrameworks(tx),
      loadAttention(tx, options.now),
    ]);
    return Object.freeze({ controls, checks, tasks, frameworks, attention });
  });
}
