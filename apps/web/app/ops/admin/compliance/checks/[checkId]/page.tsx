// /ops/admin/compliance/checks/:id — one probe, its history, its
// exceptions.
//
// The run history is the evidence an auditor actually reads, so it is
// rendered in full rather than summarized: every run shows its verdict
// line, its findings, and the digest over the details payload. The
// digest is displayed because it is the affordance that makes the
// history checkable — an exported evidence file can be re-hashed and
// compared against what is on screen.

import Link from "next/link";
import { notFound } from "next/navigation";

import {
  COMPLIANCE_EXCEPTION_MAX_DAYS,
  COMPLIANCE_EXCEPTION_REASON_CODES,
} from "@pharmax/compliance";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { getComplianceCheckDetail } from "../../../../../../src/server/compliance/get-check-detail.js";
import {
  CADENCE_LABEL,
  formatInstant,
  formatRelative,
  outcomeMeta,
  SEVERITY_META,
} from "../../../../../../src/components/compliance/meta.js";
import { ActionForm, SubmitButton } from "../../../../../../src/components/ops/action-form.js";
import { QueueFlash } from "../../../../../../src/components/ops/flash.js";
import { Badge } from "../../../../../../src/components/ui/badge.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../../../../src/components/ui/card.js";
import { DataList } from "../../../../../../src/components/ui/data.js";
import {
  Banner,
  EmptyState,
  PermissionDenied,
} from "../../../../../../src/components/ui/feedback.js";
import { Field, Input, Select, Textarea } from "../../../../../../src/components/ui/field.js";
import { PageHeader, Section } from "../../../../../../src/components/ui/page.js";

export const dynamic = "force-dynamic";

const FLASH_MESSAGES: Readonly<Record<string, string>> = {
  excepted: "Exception recorded.",
};

const REASON_LABELS: Readonly<Record<string, string>> = {
  COMPENSATING_CONTROL: "Compensating control — something else covers the risk",
  VENDOR_DEPENDENCY: "Vendor dependency — blocked on a third party",
  PLANNED_REMEDIATION: "Planned remediation — a fix is scheduled",
  ACCEPTED_RISK: "Accepted risk — we have decided to live with it",
  PROBE_DEFECT: "Probe defect — the check itself is wrong",
};

function truncateDigest(digest: string): string {
  return digest.length <= 16 ? digest : `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

export default async function ComplianceCheckDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly checkId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ checkId }, query] = await Promise.all([params, searchParams]);

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Compliance" title="Check" />
        <PermissionDenied grant="compliance.control_plane.view" />
      </div>
    );
  }

  const now = new Date();
  const check = await getComplianceCheckDetail({ checkId, now });
  if (check === null) notFound();

  const canAcceptException = hasOperatorPermission(
    permissions,
    PERMISSIONS.COMPLIANCE_EXCEPTION_ACCEPT
  );
  const outcome = outcomeMeta(check.lastOutcome);
  const severity = SEVERITY_META[check.severity];
  const activeException = check.exceptions.find((e) => e.active) ?? null;
  const isFailing = check.lastOutcome === "FAIL" || check.lastOutcome === "ERROR";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow={
          <Link href="/ops/admin/compliance/checks" className="hover:text-fg">
            ← Checks
          </Link>
        }
        title={check.title}
        description={check.description}
        actions={
          <>
            <Badge tone={severity.tone}>{severity.label}</Badge>
            {check.enabled ? (
              <Badge tone={outcome.tone}>{outcome.label}</Badge>
            ) : (
              <Badge tone="neutral">Disabled</Badge>
            )}
          </>
        }
      />

      <QueueFlash params={query} messages={FLASH_MESSAGES} />

      {!check.enabled ? (
        <Banner tone="warning" title="This check is disabled">
          It is not running and produces no evidence. Its stored outcome is whatever it concluded
          the last time it ran, which is not a statement about today.
        </Banner>
      ) : null}

      {activeException !== null ? (
        <Banner tone="info" title="An active exception covers this check">
          {REASON_LABELS[activeException.reasonCode] ?? activeException.reasonCode} — expires{" "}
          {formatInstant(activeException.expiresAt)} (
          {formatRelative(activeException.expiresAt, now)}
          ). Approved by {activeException.approvedByDisplayName ?? "an unnamed user"}.
        </Banner>
      ) : null}

      <Card>
        <CardContent>
          <DataList
            columns={4}
            items={[
              {
                label: "Registry code",
                value: <span className="font-mono text-xs">{check.code}</span>,
              },
              { label: "Cadence", value: CADENCE_LABEL[check.cadence] },
              {
                label: "Interval",
                value: check.intervalMinutes === null ? "—" : `${check.intervalMinutes} min`,
              },
              { label: "Kind", value: check.automated ? "Automated probe" : "Manual attestation" },
              {
                label: "Last run",
                value:
                  check.lastRunAt === null ? (
                    <span className="text-tone-warning">Never</span>
                  ) : (
                    formatInstant(check.lastRunAt)
                  ),
              },
              {
                label: "Next run",
                value: check.nextRunAt === null ? "—" : formatInstant(check.nextRunAt),
              },
              {
                label: "Consecutive failures",
                value: (
                  <span className={check.consecutiveFailureCount > 0 ? "text-tone-warning" : ""}>
                    {check.consecutiveFailureCount}
                  </span>
                ),
              },
              {
                label: "Evidences",
                value:
                  check.controls.length === 0 ? (
                    <span className="text-tone-warning">No control</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {check.controls.map((c) => (
                        <Link
                          key={c.controlId}
                          href={`/ops/admin/compliance/controls/${c.controlId}`}
                          className="font-mono text-xs text-tone-brand hover:underline"
                          title={c.title}
                        >
                          {c.code}
                        </Link>
                      ))}
                    </span>
                  ),
              },
            ]}
          />
        </CardContent>
      </Card>

      <Section title="Run history" count={check.runs.length}>
        {check.runs.length === 0 ? (
          <EmptyState
            icon="clock"
            title="This check has never run"
            description="It produces no evidence until the worker's compliance scheduler picks it up."
          />
        ) : (
          <div className="space-y-2">
            {check.runs.map((run) => {
              const runOutcome = outcomeMeta(run.outcome);
              return (
                <Card key={run.runId} accent={runOutcome.tone}>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={runOutcome.tone}>{runOutcome.label}</Badge>
                          <span className="text-xs text-muted">
                            {formatInstant(run.observedAt)} · {formatRelative(run.observedAt, now)}{" "}
                            · {run.durationMs}ms
                          </span>
                          {run.subjectOrganizationId !== null ? (
                            <Badge tone="neutral">Per-tenant</Badge>
                          ) : null}
                        </div>
                        <p className="text-sm text-fg">{run.summary}</p>
                      </div>
                      <span
                        className="shrink-0 font-mono text-2xs text-subtle"
                        title={`Canonical SHA-256 of the details payload: ${run.digestSha256}`}
                      >
                        {truncateDigest(run.digestSha256)}
                      </span>
                    </div>

                    {run.errorCode !== null ? (
                      <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                        <p className="font-mono text-2xs text-tone-warning-accent">
                          {run.errorCode}
                        </p>
                        {run.errorMessage !== null ? (
                          <p className="mt-0.5 text-xs text-tone-warning-strong">
                            {run.errorMessage}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {run.findings.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                          Findings ({run.findingCount})
                        </p>
                        <ul className="space-y-1">
                          {run.findings.map((f, i) => (
                            <li
                              key={`${run.runId}-${i}`}
                              className="flex flex-wrap gap-x-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs"
                            >
                              <span className="font-mono font-medium text-fg">{f.subject}</span>
                              <span className="text-muted">{f.detail}</span>
                            </li>
                          ))}
                        </ul>
                        {run.findingCount > run.findings.length ? (
                          <p className="text-2xs text-subtle">
                            Showing {run.findings.length} of {run.findingCount}.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {check.exceptions.length > 0 ? (
        <Section title="Exception history" count={check.exceptions.length}>
          <div className="space-y-2">
            {check.exceptions.map((e) => (
              <Card key={e.exceptionId} accent={e.active ? "info" : "neutral"}>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={e.active ? "info" : "neutral"}>
                      {e.active ? "Active" : e.revokedAt !== null ? "Revoked" : "Expired"}
                    </Badge>
                    <span className="font-mono text-2xs text-subtle">{e.reasonCode}</span>
                    <span className="text-xs text-muted">
                      {formatInstant(e.createdAt)} → {formatInstant(e.expiresAt)}
                    </span>
                  </div>
                  <p className="text-sm text-fg">{e.justification}</p>
                  <p className="text-xs text-subtle">
                    Approved by {e.approvedByDisplayName ?? "an unnamed user"}
                    {e.subjectOrganizationId !== null
                      ? " · scoped to one tenant"
                      : " · platform-wide"}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      {canAcceptException && isFailing && activeException === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Accept a time-boxed exception</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted">
              An exception does not fix anything. It records that a named person decided this
              failure is tolerable, why, and for how long — and it unblocks sign-off on the controls
              this check evidences. Maximum {COMPLIANCE_EXCEPTION_MAX_DAYS} days; there is no
              permanent option, because a permanent exception is an undocumented change to the
              control design.
            </p>

            <ActionForm
              action={`/api/ops/admin/compliance/checks/${check.checkId}/accept-exception`}
              className="space-y-4"
              confirm="Record this exception under your name?"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Reason" required>
                  <Select name="reasonCode" defaultValue="" required>
                    <option value="" disabled>
                      Select a reason…
                    </option>
                    {COMPLIANCE_EXCEPTION_REASON_CODES.map((code) => (
                      <option key={code} value={code}>
                        {REASON_LABELS[code] ?? code}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Duration (days)"
                  required
                  help={`1 to ${COMPLIANCE_EXCEPTION_MAX_DAYS}. It expires hard, with no renewal grace.`}
                >
                  <Input
                    name="durationDays"
                    type="number"
                    min={1}
                    max={COMPLIANCE_EXCEPTION_MAX_DAYS}
                    defaultValue={30}
                    required
                  />
                </Field>
              </div>
              <Field
                label="Justification"
                required
                help="Read aloud in the audit; write it for that audience. At least 20 characters."
              >
                <Textarea
                  name="justification"
                  minLength={20}
                  maxLength={4000}
                  rows={3}
                  required
                  placeholder="The upstream vendor has acknowledged the gap and committed to a fix in their Q4 release; we monitor manually each Monday until then."
                />
              </Field>
              <SubmitButton variant="danger" size="md" icon="alert">
                Accept exception
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
