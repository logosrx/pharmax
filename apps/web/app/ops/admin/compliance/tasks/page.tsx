// /ops/admin/compliance/tasks — remediation work.
//
// The "and then somebody fixes it" half of continuous monitoring. A
// system that detects drift but does not track the response produces
// findings, not compliance.
//
// Read-only for now: tasks are opened automatically by the scheduler
// when a check fails. Assignment and completion go through commands
// that do not have an operator surface yet, so this page deliberately
// renders no buttons it cannot honour.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import {
  isTaskListFilter,
  listComplianceTasks,
  type TaskListFilter,
} from "../../../../../src/server/compliance/list-tasks.js";
import {
  formatInstant,
  formatRelative,
  SEVERITY_META,
  TASK_STATUS_META,
} from "../../../../../src/components/compliance/meta.js";
import { Badge } from "../../../../../src/components/ui/badge.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../src/components/ui/data.js";
import { EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { FilterTabs, PageHeader } from "../../../../../src/components/ui/page.js";

export const dynamic = "force-dynamic";

const FILTER_LABELS: Readonly<Record<TaskListFilter, string>> = {
  OPEN: "Open",
  OVERDUE: "Overdue",
  DONE: "Done",
  ALL: "All",
};

const FILTER_ORDER: ReadonlyArray<TaskListFilter> = ["OPEN", "OVERDUE", "DONE", "ALL"];

export default async function ComplianceTasksPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Compliance" title="Remediation" />
        <PermissionDenied grant="compliance.control_plane.view" />
      </div>
    );
  }

  const filterRaw = params["filter"];
  const filter: TaskListFilter =
    typeof filterRaw === "string" && isTaskListFilter(filterRaw) ? filterRaw : "OPEN";
  const cursor = typeof params["cursor"] === "string" ? params["cursor"] : undefined;

  const now = new Date();
  const { rows, nextCursor } = await listComplianceTasks({
    filter,
    now,
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 50,
  });

  const base = "/ops/admin/compliance/tasks";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Compliance"
        title="Remediation"
        description="Work items opened when a check fails, plus cadence obligations that have no probe. Due dates are derived from severity at creation."
        actions={
          <Link
            href="/ops/admin/compliance"
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            Posture
          </Link>
        }
      />

      <FilterTabs
        items={FILTER_ORDER.map((f) => ({
          href: f === "OPEN" ? base : `${base}?filter=${f}`,
          label: FILTER_LABELS[f],
          active: f === filter,
        }))}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="check"
          title={filter === "OPEN" ? "No open remediation work" : "No tasks match this filter"}
          description="Failing checks open a task automatically, so an empty open list means nothing is currently failing without a response."
        />
      ) : (
        <>
          <Table>
            <THead>
              <TH>Task</TH>
              <TH>Status</TH>
              <TH>Severity</TH>
              <TH>Due</TH>
              <TH>Assignee</TH>
              <TH>Source</TH>
            </THead>
            <TBody>
              {rows.map((row) => {
                const status = TASK_STATUS_META[row.status];
                const severity = SEVERITY_META[row.severity];
                return (
                  <TR key={row.taskId}>
                    <TD>
                      <span className="text-sm text-fg">{row.title}</span>
                    </TD>
                    <TD>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={severity.tone}>{severity.label}</Badge>
                    </TD>
                    <TD>
                      <span
                        className={row.overdue ? "text-xs text-tone-danger" : "text-xs text-muted"}
                        title={formatInstant(row.dueAt)}
                      >
                        {formatRelative(row.dueAt, now)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">
                        {row.assignedToDisplayName ?? "Unassigned"}
                      </span>
                    </TD>
                    <TD>
                      <span className="font-mono text-2xs text-subtle">
                        {row.checkCode ?? row.controlCode ?? "Ad hoc"}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          {nextCursor !== null ? (
            <div className="flex justify-center">
              <Link
                href={`${base}?filter=${filter}&cursor=${encodeURIComponent(nextCursor)}`}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                Next page
              </Link>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
