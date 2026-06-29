// /ops/admin/report-schedules/new — create a new schedule.
//
// Posts to /api/ops/admin/report-schedules/create which dispatches
// CreateReportSchedule and redirects back. Gate:
// `reports.manage_schedule`.

import { REPORT_REGISTRY } from "@pharmax/reporting";
import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { PageHeader } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input, Select, Textarea } from "../../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

const DEFAULT_TEMPLATE = `{
  "from": "now-30d",
  "to": "now"
}`;

const SUGGESTED_CRONS: ReadonlyArray<{ label: string; expr: string }> = [
  { label: "Every 15 minutes", expr: "*/15 * * * *" },
  { label: "Hourly (top of hour)", expr: "0 * * * *" },
  { label: "Daily at 06:00 local", expr: "0 6 * * *" },
  { label: "Weekly Monday 09:00 local", expr: "0 9 * * 1" },
  { label: "Monthly on the 1st 09:00 local", expr: "0 9 1 * *" },
];

export default async function NewReportSchedulePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string }>;
}) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="New schedule" />
        <PermissionDenied grant="reports.manage_schedule" />
      </div>
    );
  }

  const reports = Object.values(REPORT_REGISTRY);
  const { error } = await searchParams;

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/report-schedules"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to schedules
      </Link>

      <PageHeader eyebrow="Administration" title="New schedule" />

      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      <Card>
        <CardContent>
          <ActionForm action="/api/ops/admin/report-schedules/create" className="space-y-5">
            <Field
              label="Schedule name"
              required
              help="Must be unique for the report within this org"
            >
              <Input name="name" required maxLength={120} placeholder="Weekly volume Mondays" />
            </Field>

            <Field label="Report" required>
              <Select name="reportId" required defaultValue="">
                <option value="" disabled>
                  — choose a report —
                </option>
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} ({r.id})
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Cron expression"
              required
              help={
                <details>
                  <summary className="cursor-pointer hover:text-fg">Common patterns</summary>
                  <ul className="mt-2 space-y-1">
                    {SUGGESTED_CRONS.map((c) => (
                      <li key={c.expr}>
                        <code className="rounded bg-surface-2 px-1.5 py-0.5">{c.expr}</code> —{" "}
                        {c.label}
                      </li>
                    ))}
                  </ul>
                </details>
              }
            >
              <Input
                name="cronExpression"
                required
                maxLength={120}
                placeholder="0 9 * * 1"
                className="font-mono"
              />
            </Field>

            <Field label="Timezone" required help="IANA timezone — the cron fires in this zone">
              <Input
                name="timezone"
                required
                maxLength={64}
                defaultValue="UTC"
                placeholder="America/New_York"
              />
            </Field>

            <Field
              label="Parameters template (JSON)"
              required
              help="Relative-date placeholders supported: now, now-1h, now-24h, now-7d, now-30d, now-90d. Resolved each tick."
            >
              <Textarea
                name="parametersTemplate"
                required
                rows={8}
                defaultValue={DEFAULT_TEMPLATE}
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="Email recipients"
              help="Comma/space/newline-separated (max 50). Blank = scheduled but silent (still writes to the ledger)."
            >
              <Textarea
                name="recipients"
                rows={3}
                placeholder="billing@acme.test, ops-lead@acme.test"
                className="font-mono text-xs"
              />
            </Field>

            <Field label="Notify on">
              <Select name="notifyOn" defaultValue="ALWAYS">
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
              <SubmitButton icon="check">Create schedule</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
