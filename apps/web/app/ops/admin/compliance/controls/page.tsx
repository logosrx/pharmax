// /ops/admin/compliance/controls — the control inventory.
//
// The database-backed replacement for reading
// docs/soc2/controls-inventory.md top to bottom. Same codes, same
// owners, but now joined to the probes that evidence each control and
// the tasks open against it.

import Link from "next/link";

import type { ComplianceControlStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { listComplianceControls } from "../../../../../src/server/compliance/list-controls.js";
import {
  CADENCE_LABEL,
  CONTROL_STATUS_META,
  formatDay,
  outcomeMeta,
} from "../../../../../src/components/compliance/meta.js";
import { Badge } from "../../../../../src/components/ui/badge.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../src/components/ui/data.js";
import { EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { FilterTabs, PageHeader } from "../../../../../src/components/ui/page.js";

export const dynamic = "force-dynamic";

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "IMPLEMENTED", label: "Implemented" },
  { value: "PARTIAL", label: "Partial" },
  { value: "PLANNED", label: "Planned" },
  { value: "DEPRECATED", label: "Deprecated" },
  { value: "NOT_APPLICABLE", label: "N/A" },
];

function parseStatus(raw: unknown): ComplianceControlStatus | undefined {
  if (typeof raw !== "string" || raw === "ALL") return undefined;
  return STATUS_FILTERS.some((f) => f.value === raw) ? (raw as ComplianceControlStatus) : undefined;
}

export default async function ComplianceControlsPage({
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
        <PageHeader eyebrow="Compliance" title="Controls" />
        <PermissionDenied grant="compliance.control_plane.view" />
      </div>
    );
  }

  const status = parseStatus(params["status"]);
  const cursor = typeof params["cursor"] === "string" ? params["cursor"] : undefined;

  const { rows, nextCursor } = await listComplianceControls({
    ...(status !== undefined ? { status } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 50,
  });

  const base = "/ops/admin/compliance/controls";
  const qs = status !== undefined ? `status=${status}&` : "";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Compliance"
        title="Controls"
        description="What Pharmax does to satisfy each framework criterion. Evidence is the checks column: a control with no live check is asserted, not demonstrated."
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
        items={STATUS_FILTERS.map((f) => ({
          href: f.value === "ALL" ? base : `${base}?status=${f.value}`,
          label: f.label,
          active: (f.value === "ALL" && status === undefined) || f.value === status,
        }))}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="shield"
          title="No controls match this filter"
          description="Controls are seeded from docs/soc2/controls-inventory.md."
        />
      ) : (
        <>
          <Table>
            <THead>
              <TH>Code</TH>
              <TH>Control</TH>
              <TH>Owner role</TH>
              <TH>Status</TH>
              <TH>Cadence</TH>
              <TH align="right">Criteria</TH>
              <TH>Evidence</TH>
              <TH align="right">Tasks</TH>
              <TH>Last sign-off</TH>
              <TH align="right" />
            </THead>
            <TBody>
              {rows.map((row) => {
                const statusMeta = CONTROL_STATUS_META[row.status];
                return (
                  <TR key={row.controlId}>
                    <TD>
                      <span className="font-mono text-xs font-semibold text-fg">{row.code}</span>
                    </TD>
                    <TD>
                      <span className="text-sm text-fg">{row.title}</span>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">{row.ownerRole}</span>
                    </TD>
                    <TD>
                      <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">{CADENCE_LABEL[row.cadence]}</span>
                    </TD>
                    <TD align="right">
                      <span className={row.criterionCount === 0 ? "text-tone-warning" : undefined}>
                        {row.criterionCount}
                      </span>
                    </TD>
                    <TD>
                      {row.checkCount === 0 ? (
                        // Distinct from a passing check on purpose:
                        // "nothing watches this" is the finding.
                        <Badge tone="neutral">No check</Badge>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <Badge tone={outcomeMeta(row.worstCheckOutcome).tone}>
                            {outcomeMeta(row.worstCheckOutcome).label}
                          </Badge>
                          <span className="text-2xs text-subtle">
                            {row.checkCount} check{row.checkCount === 1 ? "" : "s"}
                          </span>
                        </span>
                      )}
                    </TD>
                    <TD align="right">
                      <span className={row.openTaskCount > 0 ? "text-tone-warning" : undefined}>
                        {row.openTaskCount}
                      </span>
                    </TD>
                    <TD>
                      {row.lastSignedOffAt === null ? (
                        <span className="text-xs text-subtle">Never</span>
                      ) : (
                        <span className="text-xs text-muted">{formatDay(row.lastSignedOffAt)}</span>
                      )}
                    </TD>
                    <TD align="right">
                      <Link
                        href={`${base}/${row.controlId}`}
                        className={buttonClass({ variant: "secondary", size: "sm" })}
                      >
                        Open
                      </Link>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          {nextCursor !== null ? (
            <div className="flex justify-center">
              <Link
                href={`${base}?${qs}cursor=${encodeURIComponent(nextCursor)}`}
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
