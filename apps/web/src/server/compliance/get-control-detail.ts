// One control, everything about it, for the control detail page.
//
// The page answers three questions in order: what does this control
// claim, what evidences it, and who last put their name to it. The
// shape below follows that order rather than the schema's.

import "server-only";

import type {
  ComplianceCadence,
  ComplianceCheckOutcome,
  ComplianceCheckSeverity,
  ComplianceControlStatus,
  ComplianceFramework,
  ComplianceTaskStatus,
} from "@pharmax/database";

import { readCompliance } from "./read-context.js";

export interface ControlCriterionRow {
  readonly criterionId: string;
  readonly framework: ComplianceFramework;
  readonly code: string;
  readonly title: string;
  readonly category: string;
  /** True when a model proposed this crosswalk and a human took it. */
  readonly acceptedFromAiDraft: boolean;
}

export interface ControlCheckRow {
  readonly checkId: string;
  readonly code: string;
  readonly title: string;
  readonly severity: ComplianceCheckSeverity;
  readonly cadence: ComplianceCadence;
  readonly enabled: boolean;
  readonly automated: boolean;
  readonly lastOutcome: ComplianceCheckOutcome | null;
  readonly lastRunAt: Date | null;
  readonly nextRunAt: Date | null;
  readonly consecutiveFailureCount: number;
}

export interface ControlTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: ComplianceTaskStatus;
  readonly severity: ComplianceCheckSeverity;
  readonly dueAt: Date;
  readonly assignedToDisplayName: string | null;
}

export interface ControlDetail {
  readonly controlId: string;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly ownerRole: string;
  readonly status: ComplianceControlStatus;
  readonly cadence: ComplianceCadence;
  readonly notes: string | null;
  readonly implementationRefs: ReadonlyArray<string>;
  readonly lastSignedOffAt: Date | null;
  readonly lastSignedOffByDisplayName: string | null;
  readonly replacedByCode: string | null;
  readonly criteria: ReadonlyArray<ControlCriterionRow>;
  readonly checks: ReadonlyArray<ControlCheckRow>;
  readonly openTasks: ReadonlyArray<ControlTaskRow>;
}

/** Bounded: a control with 40 open tasks has a bigger problem. */
const TASK_LIMIT = 25;

export async function getComplianceControlDetail(controlId: string): Promise<ControlDetail | null> {
  return readCompliance("control-detail", async (tx) => {
    const row = await tx.complianceControl.findUnique({
      where: { id: controlId },
      select: {
        id: true,
        code: true,
        title: true,
        description: true,
        ownerRole: true,
        status: true,
        cadence: true,
        notes: true,
        implementationRefs: true,
        lastSignedOffAt: true,
        lastSignedOffByUser: { select: { displayName: true } },
        replacedByControl: { select: { code: true } },
        criteria: {
          select: {
            acceptedFromAiDraftId: true,
            criterion: {
              select: {
                id: true,
                framework: true,
                code: true,
                title: true,
                category: true,
              },
            },
          },
        },
        checks: {
          select: {
            check: {
              select: {
                id: true,
                code: true,
                title: true,
                severity: true,
                cadence: true,
                enabled: true,
                automated: true,
                lastOutcome: true,
                lastRunAt: true,
                nextRunAt: true,
                consecutiveFailureCount: true,
              },
            },
          },
        },
        tasks: {
          where: { status: { in: ["OPEN", "IN_PROGRESS", "BLOCKED"] } },
          select: {
            id: true,
            title: true,
            status: true,
            severity: true,
            dueAt: true,
            assignedToUser: { select: { displayName: true } },
          },
          orderBy: { dueAt: "asc" },
          take: TASK_LIMIT,
        },
      },
    });

    if (row === null) return null;

    return Object.freeze({
      controlId: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      ownerRole: row.ownerRole,
      status: row.status,
      cadence: row.cadence,
      notes: row.notes,
      implementationRefs: Object.freeze([...row.implementationRefs]),
      lastSignedOffAt: row.lastSignedOffAt,
      lastSignedOffByDisplayName: row.lastSignedOffByUser?.displayName ?? null,
      replacedByCode: row.replacedByControl?.code ?? null,
      criteria: Object.freeze(
        row.criteria
          .map((c) =>
            Object.freeze({
              criterionId: c.criterion.id,
              framework: c.criterion.framework,
              code: c.criterion.code,
              title: c.criterion.title,
              category: c.criterion.category,
              acceptedFromAiDraft: c.acceptedFromAiDraftId !== null,
            })
          )
          .sort((a, b) =>
            a.framework === b.framework
              ? a.code.localeCompare(b.code)
              : a.framework.localeCompare(b.framework)
          )
      ),
      checks: Object.freeze(
        row.checks
          .map((c) =>
            Object.freeze({
              checkId: c.check.id,
              code: c.check.code,
              title: c.check.title,
              severity: c.check.severity,
              cadence: c.check.cadence,
              enabled: c.check.enabled,
              automated: c.check.automated,
              lastOutcome: c.check.lastOutcome,
              lastRunAt: c.check.lastRunAt,
              nextRunAt: c.check.nextRunAt,
              consecutiveFailureCount: c.check.consecutiveFailureCount,
            })
          )
          .sort((a, b) => a.code.localeCompare(b.code))
      ),
      openTasks: Object.freeze(
        row.tasks.map((t) =>
          Object.freeze({
            taskId: t.id,
            title: t.title,
            status: t.status,
            severity: t.severity,
            dueAt: t.dueAt,
            assignedToDisplayName: t.assignedToUser?.displayName ?? null,
          })
        )
      ),
    });
  });
}
