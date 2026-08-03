// Remediation task list for /ops/admin/compliance/tasks.
//
// Ordered by due date ascending within the open filter, which puts
// overdue work at the top without a separate query. Cursor is the task
// id rather than dueAt, because due dates are editable by the owner
// and a mutable cursor column can skip or repeat rows mid-scroll.

import "server-only";

import type { ComplianceCheckSeverity, ComplianceTaskStatus } from "@pharmax/database";

import { readCompliance } from "./read-context.js";

export type TaskListFilter = "OPEN" | "OVERDUE" | "DONE" | "ALL";

export const TASK_LIST_FILTERS: ReadonlyArray<TaskListFilter> = ["OPEN", "OVERDUE", "DONE", "ALL"];

export function isTaskListFilter(value: string): value is TaskListFilter {
  return (TASK_LIST_FILTERS as ReadonlyArray<string>).includes(value);
}

const OPEN_STATUSES: ReadonlyArray<ComplianceTaskStatus> = ["OPEN", "IN_PROGRESS", "BLOCKED"];

export interface TaskListRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: ComplianceTaskStatus;
  readonly severity: ComplianceCheckSeverity;
  readonly dueAt: Date;
  readonly overdue: boolean;
  readonly assignedToDisplayName: string | null;
  readonly controlCode: string | null;
  readonly checkCode: string | null;
  readonly createdAt: Date;
}

export interface ListTasksResult {
  readonly rows: ReadonlyArray<TaskListRow>;
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function whereForFilter(filter: TaskListFilter, now: Date): Record<string, unknown> {
  switch (filter) {
    case "OPEN":
      return { status: { in: OPEN_STATUSES } };
    case "OVERDUE":
      return { status: { in: OPEN_STATUSES }, dueAt: { lt: now } };
    case "DONE":
      return { status: "DONE" };
    case "ALL":
      return {};
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

export async function listComplianceTasks(options: {
  readonly filter?: TaskListFilter;
  readonly now: Date;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<ListTasksResult> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filter = options.filter ?? "OPEN";

  return readCompliance("list-tasks", async (tx) => {
    const rows = await tx.complianceTask.findMany({
      where: whereForFilter(filter, options.now),
      select: {
        id: true,
        title: true,
        status: true,
        severity: true,
        dueAt: true,
        createdAt: true,
        assignedToUser: { select: { displayName: true } },
        control: { select: { code: true } },
        check: { select: { code: true } },
      },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;

    return Object.freeze({
      rows: sliced.map((r) =>
        Object.freeze({
          taskId: r.id,
          title: r.title,
          status: r.status,
          severity: r.severity,
          dueAt: r.dueAt,
          overdue:
            r.dueAt.getTime() < options.now.getTime() &&
            (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status),
          assignedToDisplayName: r.assignedToUser?.displayName ?? null,
          controlCode: r.control?.code ?? null,
          checkCode: r.check?.code ?? null,
          createdAt: r.createdAt,
        })
      ),
      nextCursor: hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null,
    });
  });
}
