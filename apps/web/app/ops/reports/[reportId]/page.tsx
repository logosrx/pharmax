// /ops/reports/[reportId] — per-report parameter form + download.
//
// The form is rendered from the report's declarative `parameterFields`
// descriptor (typed date pickers, enum selects, multi-select groups).
// Reports predating the descriptor fall back to the standard from/to
// date pair. The form POSTs to the run route which validates, runs
// RunReport, and streams CSV. A failed run redirects back with
// `?error=` and the operator's inputs preserved.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { dateRangeFields, REPORT_REGISTRY } from "@pharmax/reporting";

import { ReportParameterForm } from "../../../../src/components/report-parameter-form.js";
import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { PageHeader } from "../../../../src/components/ui/page.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

export default async function ReportRunFormPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly reportId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ reportId }, sp] = await Promise.all([params, searchParams]);

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_RUN)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Run report" />
        <PermissionDenied grant="reports.run" />
      </div>
    );
  }

  const definition = REPORT_REGISTRY[reportId];
  if (definition === undefined) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Report not found" />
        <EmptyState
          icon="reports"
          title={`No report registered with id ${reportId}`}
          action={
            <Link href="/ops/reports" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Back to reports
            </Link>
          }
        />
      </div>
    );
  }

  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  const fields = definition.parameterFields ?? dateRangeFields();

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/reports"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to reports
      </Link>

      <PageHeader
        eyebrow="Finance · Report"
        title={definition.title}
        description={definition.description}
        actions={<Badge tone="neutral">v{definition.version}</Badge>}
      />

      {flashError !== null ? (
        <Banner tone="danger" title="The report run failed">
          {flashError}
        </Banner>
      ) : null}

      <ReportParameterForm reportId={definition.id} fields={fields} values={sp} now={new Date()} />
    </div>
  );
}
