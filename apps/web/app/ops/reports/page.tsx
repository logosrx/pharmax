// /ops/reports — registered reports catalog.
//
// Lists every report definition in `REPORT_REGISTRY`. Each entry links
// to `/ops/reports/[reportId]` to pick parameters and download a CSV.
// No PHI — the registry is static. Visibility gated on `reports.run`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { REPORT_REGISTRY } from "@pharmax/reporting";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { PageHeader } from "../../../src/components/ui/page.js";
import { LinkCard } from "../../../src/components/ui/card.js";
import { Badge } from "../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../src/components/ui/feedback.js";
import { Icon } from "../../../src/components/ui/icon.js";

export default async function ReportsCatalogPage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_RUN)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Reports" />
        <PermissionDenied grant="reports.run" />
      </div>
    );
  }

  const definitions = Object.values(REPORT_REGISTRY).sort((a, b) => a.id.localeCompare(b.id));

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Finance"
        title="Reports"
        description="Run a registered report against your tenant; downloads as CSV. Every run writes a chain-hashed audit row and a report_run record for SOC-2 traceability."
        actions={
          <Link
            href="/ops/reports/runs"
            className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg transition-colors hover:bg-surface-3"
          >
            <Icon name="history" size={15} />
            Run history
          </Link>
        }
      />

      {definitions.length === 0 ? (
        <EmptyState icon="reports" title="No reports registered" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {definitions.map((def) => (
            <LinkCard
              key={def.id}
              href={`/ops/reports/${def.id}`}
              icon="reports"
              end={<Badge tone="neutral">v{def.version}</Badge>}
            >
              <h3 className="text-sm font-semibold text-fg">{def.title}</h3>
              <p className="mt-0.5 text-sm text-muted">{def.description}</p>
              <code className="text-[11px] text-subtle">{def.id}</code>
            </LinkCard>
          ))}
        </div>
      )}
    </div>
  );
}
