// /ops/reports/[reportId] — per-report parameter form + download.
//
// The form is rendered from the report's declarative
// `parameterFields` descriptor (typed date pickers, enum selects,
// multi-select checkbox groups). Reports that predate the
// descriptor fall back to the standard `from`/`to` date pair.
// The form POSTs to the run route which coerces + validates the
// parameters, dispatches RunReport, and streams CSV.
//
// Server-rendered + URL-bound: a failed run redirects back with
// `?error=` and the operator's inputs preserved via searchParams.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { dateRangeFields, REPORT_REGISTRY } from "@pharmax/reporting";

import { ReportParameterForm } from "../../../../src/components/report-parameter-form.js";
import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";

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
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Run report</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to run reports. Contact your admin to request{" "}
          <code className="text-neutral-200">reports.run</code>.
        </p>
      </main>
    );
  }

  const definition = REPORT_REGISTRY[reportId];
  if (definition === undefined) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Report not found</h1>
        <p className="text-sm text-neutral-400">
          No report registered with id <code className="font-mono">{reportId}</code>.{" "}
          <Link href="/ops/reports" className="text-blue-400 hover:underline">
            ← Back to reports
          </Link>
        </p>
      </main>
    );
  }

  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  // Reports declare typed `parameterFields`; older reports fall
  // back to the standard from/to date pair.
  const fields = definition.parameterFields ?? dateRangeFields();

  return (
    <main className="space-y-6">
      <div>
        <Link href="/ops/reports" className="text-sm text-blue-400 hover:underline">
          ← Back to reports
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">{definition.title}</h1>
        <p className="text-sm text-neutral-400">{definition.description}</p>
        <p className="text-xs text-neutral-500">
          <code className="font-mono">{definition.id}</code> · v{definition.version}
        </p>
      </header>

      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      <ReportParameterForm reportId={definition.id} fields={fields} values={sp} now={new Date()} />
    </main>
  );
}
