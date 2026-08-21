// /ops/admin/practices — clinic (practice) directory.
//
// Read-only list of the clinics this org fills for, with their
// pharmacy-site links and aggregate roster/order counts. No PHI —
// patient identity never surfaces here, only counts.
//
// Permission gate: `clinics.read`.

import Link from "next/link";

import type { ClinicStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listClinics } from "../../../../src/server/ops/list-clinics.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";

function statusTone(status: ClinicStatus): Tone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "INACTIVE":
      return "warning";
    case "ARCHIVED":
      return "neutral";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export default async function PracticeAdminPage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.CLINICS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Practices" />
        <PermissionDenied grant="clinics.read" />
      </div>
    );
  }

  const clinics = await listClinics({ organizationId: session.tenancy.organizationId });
  const canCreate = hasOperatorPermission(permissions, PERMISSIONS.CLINICS_CREATE);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Directory"
        title="Practices"
        description="The clinics and practice accounts this organization fills for, with their pharmacy-site links. Counts are aggregates — patient identity lives behind the PHI-gated roster."
        actions={
          canCreate ? (
            <Link href="/ops/admin/practices/new" className={buttonClass({ variant: "go" })}>
              New client
            </Link>
          ) : undefined
        }
      />

      {clinics.length === 0 ? (
        <EmptyState
          icon="practices"
          title="No practices configured"
          description="Practices are the clinic accounts that submit prescriptions — orders can't be attributed to a clinic until one exists."
          action={
            canCreate
              ? { href: "/ops/admin/practices/new", label: "Onboard the first client" }
              : undefined
          }
        />
      ) : (
        <Section title="Practices" count={clinics.length}>
          <Table>
            <THead>
              <TH>Code</TH>
              <TH>Name</TH>
              <TH>Status</TH>
              <TH>Fills from</TH>
              <TH align="right">Patients</TH>
              <TH align="right">Orders</TH>
            </THead>
            <TBody>
              {clinics.map((clinic) => (
                <TR key={clinic.clinicId}>
                  <TD className="font-mono text-xs font-medium">
                    <Link
                      href={`/ops/admin/practices/${clinic.clinicId}`}
                      className="text-brand hover:underline"
                    >
                      {clinic.code}
                    </Link>
                  </TD>
                  <TD className="font-medium">{clinic.name}</TD>
                  <TD>
                    <Badge tone={statusTone(clinic.status)}>{clinic.status}</Badge>
                  </TD>
                  <TD>
                    {clinic.sites.length === 0 ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {clinic.sites.map((site) => (
                          <Badge key={site.siteCode} tone={site.isPrimary ? "brand" : "neutral"}>
                            {site.siteCode}
                            {site.isPrimary ? " · primary" : ""}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TD>
                  <TD align="right">{clinic.patientCount}</TD>
                  <TD align="right">{clinic.orderCount}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      )}
    </div>
  );
}
