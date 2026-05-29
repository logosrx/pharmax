// /ops/reports — registered reports catalog.
//
// Lists every report definition in `REPORT_REGISTRY` with title +
// description + id. Each entry links to `/ops/reports/[reportId]`
// where the operator picks parameters and downloads a CSV.
//
// No PHI on this page — the registry is static + non-PHI. Visibility
// gated on `reports.run`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { REPORT_REGISTRY } from "@pharmax/reporting";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";

export default async function ReportsCatalogPage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_RUN)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Reports</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to run reports. Contact your admin to request{" "}
          <code className="text-neutral-200">reports.run</code>.
        </p>
      </main>
    );
  }

  const definitions = Object.values(REPORT_REGISTRY).sort((a, b) => a.id.localeCompare(b.id));

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Reports</h1>
        <p className="text-sm text-neutral-400">
          Run a registered report against your tenant; downloads as CSV. Every run writes a
          chain-hashed audit row + a <code>report_run</code> record for SOC-2 traceability.
        </p>
      </header>

      {definitions.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No reports are registered.
        </div>
      ) : (
        <ul className="space-y-3">
          {definitions.map((def) => (
            <li key={def.id} className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <Link
                  href={`/ops/reports/${def.id}`}
                  className="text-base text-neutral-100 hover:text-blue-300 hover:underline"
                >
                  {def.title}
                </Link>
                <span className="text-xs text-neutral-500">
                  <code className="font-mono">{def.id}</code> · v{def.version}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-400">{def.description}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
