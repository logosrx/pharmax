// /ops/admin/compliance — posture overview for the control plane.
//
// The landing surface for Pharmax's OWN SOC 2 / HIPAA program. This is
// not tenant data: the controls, probes, and evidence here describe the
// platform, which is why the reads run in system context.
//
// Read-only. Sign-off and exception acceptance are named human acts
// and live on the detail pages behind their own grants.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getCompliancePostureOverview } from "../../../../src/server/compliance/get-posture-overview.js";
import {
  CONTROL_STATUS_META,
  FRAMEWORK_LABEL,
  formatInstant,
  formatRelative,
  outcomeMeta,
  SEVERITY_META,
} from "../../../../src/components/compliance/meta.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../src/components/ui/card.js";
import { Stat, Table, TBody, TD, TH, THead, TR } from "../../../../src/components/ui/data.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";

export const dynamic = "force-dynamic";

export default async function CompliancePosturePage() {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Compliance" title="Posture" />
        <PermissionDenied grant="compliance.control_plane.view" />
      </div>
    );
  }

  const now = new Date();
  const overview = await getCompliancePostureOverview({ now });

  const { controls, checks, tasks, frameworks, attention } = overview;
  const failing = checks.byOutcome.FAIL;
  const erroring = checks.byOutcome.ERROR;

  // A seeded-but-never-run plane is the expected first state, and it
  // must not look like a passing one.
  const nothingHasRun = checks.enabled > 0 && checks.enabled === checks.neverRun;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Compliance"
        title="Posture"
        description="Pharmax's own SOC 2 and HIPAA control program. Controls describe what we do; checks are automated probes that produce evidence continuously; tasks are the remediation work a failing check opens."
        actions={
          <>
            <Link
              href="/ops/admin/compliance/controls"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Controls
            </Link>
            <Link
              href="/ops/admin/compliance/checks"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Checks
            </Link>
            <Link
              href="/ops/admin/compliance/tasks"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Tasks
            </Link>
          </>
        }
      />

      {controls.total === 0 ? (
        <Banner tone="info" title="The control plane is empty">
          Seed it from the markdown inventory with{" "}
          <code>pnpm tsx scripts/compliance/seed-control-plane.ts</code>.
        </Banner>
      ) : null}

      {nothingHasRun ? (
        <Banner tone="warning" title="No check has produced evidence yet">
          {checks.enabled} checks are enabled but none has run. Continuous monitoring is only a
          claim until the worker&rsquo;s compliance scheduler is running.
        </Banner>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Controls"
          value={controls.total}
          icon="shield"
          hint={`${controls.byStatus.IMPLEMENTED} implemented · ${controls.byStatus.PARTIAL} partial · ${controls.byStatus.PLANNED} planned`}
        />
        <Stat
          label="Failing checks"
          value={failing + erroring}
          icon="alert"
          tone={failing + erroring > 0 ? "danger" : "success"}
          hint={
            failing + erroring > 0
              ? `${failing} failing · ${erroring} errored`
              : "Every enabled check that has run is passing"
          }
        />
        <Stat
          label="Unevidenced"
          value={checks.neverRun + checks.disabled}
          icon="clock"
          tone={checks.neverRun + checks.disabled > 0 ? "warning" : "neutral"}
          hint={`${checks.neverRun} never run · ${checks.disabled} disabled`}
        />
        <Stat
          label="Open tasks"
          value={tasks.open}
          icon="history"
          tone={tasks.overdue > 0 ? "warning" : "neutral"}
          hint={tasks.overdue > 0 ? `${tasks.overdue} past due` : "None past due"}
        />
      </div>

      {controls.neverSignedOff > 0 ? (
        <Banner tone="warning" title="Controls without a human attestation">
          {controls.neverSignedOff} control{controls.neverSignedOff === 1 ? " is" : "s are"} marked
          implemented or partial but nobody has signed off on{" "}
          {controls.neverSignedOff === 1 ? "it" : "them"}. Automated checks produce evidence; a
          named person still has to attest that the control is designed and operating.
        </Banner>
      ) : null}

      <Section title="Framework coverage">
        {frameworks.length === 0 ? (
          <EmptyState
            icon="shield"
            title="No criteria loaded"
            description="Criteria are seeded from docs/soc2/trust-service-criteria-mapping.md."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {frameworks.map((f) => {
              const pct =
                f.totalCriteria === 0 ? 0 : Math.round((f.mappedCriteria / f.totalCriteria) * 100);
              return (
                <Card key={f.framework}>
                  <CardHeader>
                    <CardTitle>{FRAMEWORK_LABEL[f.framework]}</CardTitle>
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {f.mappedCriteria}/{f.totalCriteria}
                    </span>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                      role="img"
                      aria-label={`${pct}% of criteria have a control mapped`}
                    >
                      <div
                        className="h-full rounded-full bg-brand transition-[width]"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {/* Deliberately "mapped", never "compliant" — a
                        mapped control may still be PLANNED. */}
                    <p className="text-xs text-muted">
                      {pct}% of criteria have at least one control mapped. Mapping is not
                      satisfaction: open a criterion to see whether its controls are implemented and
                      evidenced.
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Needs attention"
        count={attention.length}
        aside={
          <Link href="/ops/admin/compliance/checks?filter=ATTENTION" className="hover:text-fg">
            View all checks →
          </Link>
        }
      >
        {attention.length === 0 ? (
          <EmptyState
            icon="check"
            title="No check is failing"
            description="Every enabled check that has run reached a passing verdict."
          />
        ) : (
          <Table>
            <THead>
              <TH>Check</TH>
              <TH>Severity</TH>
              <TH>Outcome</TH>
              <TH align="right">Consecutive</TH>
              <TH>Last run</TH>
              <TH>Exception</TH>
              <TH align="right" />
            </THead>
            <TBody>
              {attention.map((row) => {
                const outcome = outcomeMeta(row.outcome);
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
                      <Badge tone={outcome.tone}>{outcome.label}</Badge>
                    </TD>
                    <TD align="right">{row.consecutiveFailureCount}</TD>
                    <TD>
                      {row.lastRunAt === null ? (
                        <span className="text-xs text-subtle">—</span>
                      ) : (
                        <span className="text-xs text-muted" title={formatInstant(row.lastRunAt)}>
                          {formatRelative(row.lastRunAt, now)}
                        </span>
                      )}
                    </TD>
                    <TD>
                      {row.exceptionExpiresAt === null ? (
                        <span className="text-xs text-subtle">—</span>
                      ) : (
                        <Badge tone="info">
                          Until {formatInstant(row.exceptionExpiresAt).slice(0, 10)}
                        </Badge>
                      )}
                    </TD>
                    <TD align="right">
                      <Link
                        href={`/ops/admin/compliance/checks/${row.checkId}`}
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
        )}
      </Section>

      <Section title="Control status">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {(["IMPLEMENTED", "PARTIAL", "PLANNED", "DEPRECATED", "NOT_APPLICABLE"] as const).map(
            (status) => {
              const meta = CONTROL_STATUS_META[status];
              return (
                <Link
                  key={status}
                  href={`/ops/admin/compliance/controls?status=${status}`}
                  className="rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong"
                >
                  <p className="text-2xl font-semibold tabular-nums text-fg">
                    {controls.byStatus[status]}
                  </p>
                  <Badge tone={meta.tone} className="mt-2">
                    {meta.label}
                  </Badge>
                </Link>
              );
            }
          )}
        </div>
      </Section>
    </div>
  );
}
