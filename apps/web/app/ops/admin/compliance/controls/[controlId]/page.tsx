// /ops/admin/compliance/controls/:id — one control and its evidence.
//
// Layout follows the question order an auditor asks: what does this
// control claim, which criteria does it answer, what evidences it, and
// who signed it.
//
// The sign-off form is rendered only with
// `compliance.control.sign_off`, and is disabled outright when a
// linked check is failing without an active exception — the same
// condition SignOffControl refuses on. The button is disabled as a
// courtesy; the command is the enforcement, and the page says so
// rather than implying the UI is the gate.

import Link from "next/link";
import { notFound } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { getComplianceControlDetail } from "../../../../../../src/server/compliance/get-control-detail.js";
import {
  CADENCE_LABEL,
  CONTROL_STATUS_META,
  FRAMEWORK_SHORT_LABEL,
  formatInstant,
  formatRelative,
  outcomeMeta,
  SEVERITY_META,
  TASK_STATUS_META,
} from "../../../../../../src/components/compliance/meta.js";
import { ActionForm, SubmitButton } from "../../../../../../src/components/ops/action-form.js";
import { QueueFlash } from "../../../../../../src/components/ops/flash.js";
import { Badge } from "../../../../../../src/components/ui/badge.js";
import { buttonClass } from "../../../../../../src/components/ui/button.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../../../../src/components/ui/card.js";
import {
  DataList,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../../../../../../src/components/ui/data.js";
import {
  Banner,
  EmptyState,
  PermissionDenied,
} from "../../../../../../src/components/ui/feedback.js";
import { Field, Select, Textarea } from "../../../../../../src/components/ui/field.js";
import { PageHeader, Section } from "../../../../../../src/components/ui/page.js";

export const dynamic = "force-dynamic";

const FLASH_MESSAGES: Readonly<Record<string, string>> = {
  "signed-off": "Control attested.",
};

export default async function ComplianceControlDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly controlId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ controlId }, query] = await Promise.all([params, searchParams]);

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_CONTROL_PLANE_VIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Compliance" title="Control" />
        <PermissionDenied grant="compliance.control_plane.view" />
      </div>
    );
  }

  const control = await getComplianceControlDetail(controlId);
  if (control === null) notFound();

  const now = new Date();
  const canSignOff = hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_CONTROL_SIGN_OFF);
  const statusMeta = CONTROL_STATUS_META[control.status];

  // Mirrors the command's guard. Disabled checks are excluded: an
  // operator already made a deliberate decision about those.
  const blockingChecks = control.checks.filter(
    (c) => c.enabled && (c.lastOutcome === "FAIL" || c.lastOutcome === "ERROR")
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow={
          <Link href="/ops/admin/compliance/controls" className="hover:text-fg">
            ← Controls
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-lg text-muted">{control.code}</span>
            <span>{control.title}</span>
          </span>
        }
        actions={<Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>}
      />

      <QueueFlash params={query} messages={FLASH_MESSAGES} />

      {control.replacedByCode !== null ? (
        <Banner tone="warning" title="This control has been superseded">
          Replaced by <code>{control.replacedByCode}</code>. It is retained so historical mappings
          and evidence still resolve.
        </Banner>
      ) : null}

      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-fg">{control.description}</p>
          <DataList
            columns={3}
            items={[
              { label: "Owner role", value: control.ownerRole },
              { label: "Review cadence", value: CADENCE_LABEL[control.cadence] },
              {
                label: "Last signed off",
                value:
                  control.lastSignedOffAt === null ? (
                    <span className="text-tone-warning">Never</span>
                  ) : (
                    <span title={formatInstant(control.lastSignedOffAt)}>
                      {formatInstant(control.lastSignedOffAt)}
                      {control.lastSignedOffByDisplayName !== null
                        ? ` — ${control.lastSignedOffByDisplayName}`
                        : ""}
                    </span>
                  ),
                span: 3,
              },
              ...(control.notes !== null
                ? [{ label: "Notes", value: control.notes, span: 3 as const }]
                : []),
              ...(control.implementationRefs.length > 0
                ? [
                    {
                      label: "Implementation",
                      value: (
                        <ul className="space-y-0.5">
                          {control.implementationRefs.map((ref) => (
                            <li key={ref} className="font-mono text-xs text-muted">
                              {ref}
                            </li>
                          ))}
                        </ul>
                      ),
                      span: 3 as const,
                    },
                  ]
                : []),
            ]}
          />
        </CardContent>
      </Card>

      <Section title="Criteria satisfied" count={control.criteria.length}>
        {control.criteria.length === 0 ? (
          <EmptyState
            icon="alert"
            title="This control is mapped to no criterion"
            description="An unmapped control does not contribute to any framework's coverage. Either map it or mark it not applicable."
          />
        ) : (
          <Table>
            <THead>
              <TH>Framework</TH>
              <TH>Code</TH>
              <TH>Criterion</TH>
              <TH>Category</TH>
              <TH>Source</TH>
            </THead>
            <TBody>
              {control.criteria.map((c) => (
                <TR key={c.criterionId}>
                  <TD>
                    <Badge tone="neutral">{FRAMEWORK_SHORT_LABEL[c.framework]}</Badge>
                  </TD>
                  <TD>
                    <span className="font-mono text-xs font-semibold text-fg">{c.code}</span>
                  </TD>
                  <TD>
                    <span className="text-sm text-fg">{c.title}</span>
                  </TD>
                  <TD>
                    <span className="text-xs text-muted">{c.category}</span>
                  </TD>
                  <TD>
                    {c.acceptedFromAiDraft ? (
                      // Model-proposed, human-accepted. Surfaced
                      // because an auditor is entitled to ask which
                      // crosswalks a machine suggested.
                      <Badge tone="violet">AI-proposed, accepted</Badge>
                    ) : (
                      <span className="text-xs text-subtle">Authored</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Evidence" count={control.checks.length}>
        {control.checks.length === 0 ? (
          <EmptyState
            icon="alert"
            title="No check evidences this control"
            description="The control is asserted but not demonstrated. Anything relying on it is taking your word for it."
          />
        ) : (
          <Table>
            <THead>
              <TH>Check</TH>
              <TH>Severity</TH>
              <TH>Outcome</TH>
              <TH>Last run</TH>
              <TH>Next run</TH>
              <TH align="right" />
            </THead>
            <TBody>
              {control.checks.map((c) => {
                const outcome = outcomeMeta(c.lastOutcome);
                const severity = SEVERITY_META[c.severity];
                return (
                  <TR key={c.checkId}>
                    <TD>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-fg">{c.title}</p>
                        <p className="font-mono text-2xs text-subtle">{c.code}</p>
                      </div>
                    </TD>
                    <TD>
                      <Badge tone={severity.tone}>{severity.label}</Badge>
                    </TD>
                    <TD>
                      {c.enabled ? (
                        <Badge tone={outcome.tone}>{outcome.label}</Badge>
                      ) : (
                        <Badge tone="neutral">Disabled</Badge>
                      )}
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">
                        {c.lastRunAt === null ? "—" : formatRelative(c.lastRunAt, now)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">
                        {c.nextRunAt === null ? "—" : formatRelative(c.nextRunAt, now)}
                      </span>
                    </TD>
                    <TD align="right">
                      <Link
                        href={`/ops/admin/compliance/checks/${c.checkId}`}
                        className={buttonClass({ variant: "ghost", size: "sm" })}
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

      {control.openTasks.length > 0 ? (
        <Section title="Open remediation" count={control.openTasks.length}>
          <Table>
            <THead>
              <TH>Task</TH>
              <TH>Status</TH>
              <TH>Severity</TH>
              <TH>Due</TH>
              <TH>Assignee</TH>
            </THead>
            <TBody>
              {control.openTasks.map((t) => {
                const status = TASK_STATUS_META[t.status];
                const severity = SEVERITY_META[t.severity];
                const overdue = t.dueAt.getTime() < now.getTime();
                return (
                  <TR key={t.taskId}>
                    <TD>
                      <span className="text-sm text-fg">{t.title}</span>
                    </TD>
                    <TD>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={severity.tone}>{severity.label}</Badge>
                    </TD>
                    <TD>
                      <span className={overdue ? "text-xs text-tone-danger" : "text-xs text-muted"}>
                        {formatRelative(t.dueAt, now)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-xs text-muted">
                        {t.assignedToDisplayName ?? "Unassigned"}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Section>
      ) : null}

      {canSignOff ? (
        <Card>
          <CardHeader>
            <CardTitle>Attest to this control</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted">
              Automated checks establish that the platform keeps verifying this control. Sign-off
              records that a named person looked at the result and stands behind it. Your name and
              the note below go into the audit record.
            </p>

            {blockingChecks.length > 0 ? (
              <Banner tone="danger" title="Sign-off is blocked by failing evidence">
                {blockingChecks.map((c) => c.code).join(", ")}{" "}
                {blockingChecks.length === 1 ? "is" : "are"} failing with no active exception.
                Attesting now would create a signed claim contradicted by the run history beside it.
                Fix the finding, or accept a time-boxed exception on the check first.
              </Banner>
            ) : null}

            <ActionForm
              action={`/api/ops/admin/compliance/controls/${control.controlId}/sign-off`}
              className="space-y-4"
              confirm="Record your attestation for this control?"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field
                  label="Status you are attesting to"
                  required
                  help="What you believe the control's condition to be, as of now."
                >
                  <Select name="status" defaultValue={control.status} required>
                    <option value="IMPLEMENTED">Implemented</option>
                    <option value="PARTIAL">Partial</option>
                    <option value="PLANNED">Planned</option>
                    <option value="DEPRECATED">Deprecated</option>
                    <option value="NOT_APPLICABLE">Not applicable</option>
                  </Select>
                </Field>
              </div>
              <Field
                label="Attestation note"
                help="What you checked, and anything a reader of the audit file would need to know. Optional, but a bare signature explains nothing."
              >
                <Textarea
                  name="attestationNote"
                  maxLength={4000}
                  rows={3}
                  placeholder="Reviewed the last four quarterly runs and the RBAC role definitions; no exceptions outstanding."
                />
              </Field>
              <SubmitButton variant="primary" size="md" icon="shield">
                Sign off
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
