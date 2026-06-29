// /ops/admin/report-schedules/[id]/edit — edit a schedule.
//
// Edit form (UpdateReportSchedule) + a separate disable form so the
// operator can't accidentally disable while editing. reportId is NOT
// editable (create a new schedule + disable the old). Gate:
// `reports.manage_schedule`.

import Link from "next/link";
import { notFound } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { getReportScheduleById } from "../../../../../../src/server/ops/list-report-schedules.js";
import { PageHeader } from "../../../../../../src/components/ui/page.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../../../../src/components/ui/card.js";
import { Badge } from "../../../../../../src/components/ui/badge.js";
import { Banner, PermissionDenied } from "../../../../../../src/components/ui/feedback.js";
import { Field, Input, Select, Textarea } from "../../../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../../src/components/ops/action-form.js";

export default async function EditReportSchedulePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly flash?: string; readonly error?: string }>;
}) {
  const { id } = await params;
  const { flash, error } = await searchParams;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Edit schedule" />
        <PermissionDenied grant="reports.manage_schedule" />
      </div>
    );
  }

  const row = await getReportScheduleById({ tenancy: result.tenancy, reportScheduleId: id });
  if (row === null) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/report-schedules"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to schedules
      </Link>

      <PageHeader
        eyebrow="Administration"
        title={row.name}
        description={
          <span>
            Report <code>{row.reportId}</code>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{row.status}</Badge>
            <Link
              href={`/ops/admin/report-schedules/${row.id}/runs`}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              <Icon name="history" size={14} />
              Run history
            </Link>
          </div>
        }
      />

      {typeof flash === "string" && flash.length > 0 ? (
        <Banner tone="success">{flash}</Banner>
      ) : null}
      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      <Card>
        <CardContent>
          <ActionForm
            action={`/api/ops/admin/report-schedules/${row.id}/update`}
            className="space-y-5"
          >
            <Field label="Schedule name" required>
              <Input name="name" required maxLength={120} defaultValue={row.name} />
            </Field>
            <Field label="Cron expression" required>
              <Input
                name="cronExpression"
                required
                maxLength={120}
                defaultValue={row.cronExpression}
                className="font-mono"
              />
            </Field>
            <Field label="Timezone" required>
              <Input name="timezone" required maxLength={64} defaultValue={row.timezone} />
            </Field>
            <Field label="Parameters template (JSON)" required>
              <Textarea
                name="parametersTemplate"
                required
                rows={8}
                defaultValue={JSON.stringify(row.parametersTemplate, null, 2)}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Status">
              <Select name="status" defaultValue={row.status}>
                <option value="ACTIVE">ACTIVE — included in worker tick</option>
                <option value="PAUSED">PAUSED — visible but not dispatched</option>
                <option value="DISABLED">DISABLED — soft-deleted</option>
              </Select>
            </Field>
            <Field
              label="Email recipients"
              help="Comma/space/newline-separated (max 50). Blank = silent."
            >
              <Textarea
                name="recipients"
                rows={3}
                defaultValue={row.recipients.join(", ")}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Notify on">
              <Select name="notifyOn" defaultValue={row.notifyOn}>
                <option value="ALWAYS">ALWAYS — every dispatch</option>
                <option value="FAILURE_ONLY">FAILURE_ONLY — only failed / skipped runs</option>
                <option value="NEVER">NEVER — mute notifications (still runs)</option>
              </Select>
            </Field>
            <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
              <Link
                href="/ops/admin/report-schedules"
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                Cancel
              </Link>
              <SubmitButton icon="check">Save changes</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <Card accent="danger">
        <CardHeader>
          <CardTitle className="text-red-300">Disable schedule</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs text-muted">
            Soft-deletes the schedule. The audit trail is preserved; an admin can resurrect by
            editing the row and choosing <code>ACTIVE</code>.
          </p>
          <ActionForm
            action={`/api/ops/admin/report-schedules/${row.id}/disable`}
            confirm="Disable this schedule?"
          >
            <SubmitButton variant="danger" icon="x">
              Disable
            </SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
