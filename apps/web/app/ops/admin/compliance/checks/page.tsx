// /ops/admin/compliance/checks — the automated probe inventory.
//
// Continuous monitoring is only a claim if you can see which probes
// ran, when, and what they concluded. "Never run" and "Disabled" are
// first-class filters here for that reason: both are states in which a
// check produces no evidence while its stored outcome may still read
// PASS from whenever it last ran.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import {
  isCheckListFilter,
  listComplianceChecks,
  type CheckListFilter,
} from "../../../../../src/server/compliance/list-checks.js";
import {
  CADENCE_LABEL,
  formatInstant,
  formatRelative,
  outcomeMeta,
  SEVERITY_META,
} from "../../../../../src/components/compliance/meta.js";
import { Badge } from "../../../../../src/components/ui/badge.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../src/components/ui/data.js";
import { EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { FilterTabs, PageHeader } from "../../../../../src/components/ui/page.js";

export const dynamic = "force-dynamic";

const FILTER_LABELS: Readonly<Record<CheckListFilter, string>> = {
  ALL: "All",
  ATTENTION: "Needs attention",
  PASS: "Passing",
  FAIL: "Failing",
  ERROR: "Errored",
  NEVER_RUN: "Never run",
  DISABLED: "Disabled",
};

const FILTER_ORDER: ReadonlyArray<CheckListFilter> = [
  "ALL",
  "ATTENTION",
  "PASS",
  "FAIL",
  "ERROR",
  "NEVER_RUN",
  "DISABLED",
];

export default async function ComplianceChecksPage({
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
        <PageHeader eyebrow="Compliance" title="Checks" />
        <PermissionDenied grant="compliance.control_plane.view" />
      </div>
    );
  }

  const filterRaw = params["filter"];
  const filter: CheckListFilter =
    typeof filterRaw === "string" && isCheckListFilter(filterRaw) ? filterRaw : "ALL";
  const cursor = typeof params["cursor"] === "string" ? params["cursor"] : undefined;

  const now = new Date();
  const { rows, nextCursor } = await listComplianceChecks({
    filter,
    now,
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 50,
  });

  const base = "/ops/admin/compliance/checks";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Compliance"
        title="Checks"
        description="Automated probes that read the platform's own state and produce evidence on a schedule. Each run is written append-only and digest-sealed; the operator cannot delete the runs that failed."
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
          href: f === "ALL" ? base : `${base}?filter=${f}`,
          label: FILTER_LABELS[f],
          active: f === filter,
        }))}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="check"
          title="No checks match this filter"
          description="Probes are defined in packages/compliance and seeded into the plane by scripts/compliance/seed-control-plane.ts."
        />
      ) : (
        <>
          <Table>
            <THead>
              <TH>Check</TH>
              <TH>Severity</TH>
              <TH>Outcome</TH>
              <TH align="right">Consecutive</TH>
              <TH>Cadence</TH>
              <TH>Last run</TH>
              <TH>Next run</TH>
              <TH>Evidences</TH>
              <TH align="right" />
            </THead>
            <TBody>
              {rows.map((row) => {
                const outcome = outcomeMeta(row.lastOutcome);
                const severity = SEVERITY_META[row.severity];
                return (
                  <TR key={row.checkId}>
                    <TD>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-fg">{row.title}</p>
                        <p className="font-mono text-2xs text-subtle">{row.code}</p>
                      </div>
                    </TD>
                    <TD>
                      <Badge tone={severity.tone}>{severity.label}</Badge>
                    </TD>
                    <TD>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {row.enabled ? (
                          <Badge tone={outcome.tone}>{outcome.label}</Badge>
                        ) : (
                          <Badge tone="neutral">Disabled</Badge>
                        )}
                        {row.exceptionExpiresAt !== null ? (
                          <Badge tone="info">Excepted</Badge>
                        ) : null}
                      </span>
                    </TD>
                    <TD align="right">
                      <span
                        className={
                          row.consecutiveFailureCount > 0 ? "text-tone-warning" : undefined
                        }
                      >
                        {row.consecutiveFailureCount}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">{CADENCE_LABEL[row.cadence]}</span>
                    </TD>
                    <TD>
                      <span
                        className="text-xs text-muted"
                        title={row.lastRunAt === null ? undefined : formatInstant(row.lastRunAt)}
                      >
                        {row.lastRunAt === null ? "—" : formatRelative(row.lastRunAt, now)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">
                        {row.nextRunAt === null ? "—" : formatRelative(row.nextRunAt, now)}
                      </span>
                    </TD>
                    <TD>
                      <span className="font-mono text-2xs text-subtle">
                        {row.controlCodes.length === 0 ? "—" : row.controlCodes.join(", ")}
                      </span>
                    </TD>
                    <TD align="right">
                      <Link
                        href={`${base}/${row.checkId}`}
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
