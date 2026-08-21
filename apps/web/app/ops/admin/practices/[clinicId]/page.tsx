// /ops/admin/practices/[clinicId] — client detail and prescriber roster.
//
// Four things on one page, because they are the four questions asked
// about a client:
//
//   1. Who are they, and what fills for them.
//   2. Who may prescribe for them right now.
//   3. Who used to, and why they stopped — the access-review question,
//      answerable here rather than from the audit log.
//   4. Are they still open for business.
//
// Two consequences are surfaced rather than left to be discovered:
// deactivating signs prescribers out of the client, and archiving is
// refused while orders are in flight. Both are enforced server-side by
// SetClinicStatus; saying so here is what stops an operator finding out
// from a support ticket.
//
// Permission gates: `clinics.read` to view, `clinics.affiliate_provider`
// for the roster forms, `clinics.update` / `clinics.set_status` for the
// lifecycle forms. No PHI — prescriber identity is public registry
// data and patient figures are aggregate counts.

import Link from "next/link";
import { notFound } from "next/navigation";

import { ClinicStatus, type ProviderStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { getClinicDetail } from "../../../../../src/server/ops/get-clinic-detail.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../../src/components/ui/data.js";
import { Badge, type Tone } from "../../../../../src/components/ui/badge.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

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

function providerTone(status: ProviderStatus): Tone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "INACTIVE":
      return "warning";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Target statuses reachable from the current one; mirrors SetClinicStatus. */
function nextStatuses(current: ClinicStatus): ReadonlyArray<ClinicStatus> {
  switch (current) {
    case "ACTIVE":
      return [ClinicStatus.INACTIVE];
    case "INACTIVE":
      return [ClinicStatus.ACTIVE, ClinicStatus.ARCHIVED];
    case "ARCHIVED":
      return [];
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

const STATUS_ACTION_LABELS: Readonly<Record<ClinicStatus, string>> = {
  ACTIVE: "Reactivate",
  INACTIVE: "Deactivate",
  ARCHIVED: "Archive",
};

export default async function PracticeDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly clinicId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { clinicId } = await params;
  const query = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.CLINICS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Client" />
        <PermissionDenied grant="clinics.read" />
      </div>
    );
  }

  const clinic = await getClinicDetail({
    organizationId: session.tenancy.organizationId,
    clinicId,
  });
  if (clinic === null) notFound();

  const canAffiliate = hasOperatorPermission(permissions, PERMISSIONS.CLINICS_AFFILIATE_PROVIDER);
  const canUpdate = hasOperatorPermission(permissions, PERMISSIONS.CLINICS_UPDATE);
  const canSetStatus = hasOperatorPermission(permissions, PERMISSIONS.CLINICS_SET_STATUS);

  const flash = typeof query["flash"] === "string" ? query["flash"] : null;
  const flashError = typeof query["error"] === "string" ? query["error"] : null;
  const archived = clinic.status === ClinicStatus.ARCHIVED;
  const transitions = nextStatuses(clinic.status);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/practices"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to clients
      </Link>

      <PageHeader
        eyebrow="Client"
        title={clinic.name}
        description={`Code ${clinic.code} · onboarded ${clinic.createdAt.toLocaleDateString("en-US")}`}
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="Action failed">
          {flashError}
        </Banner>
      ) : null}
      {archived ? (
        <Banner tone="neutral" title="This client is archived">
          Archived clients are retained to explain historical invoices and orders. They cannot be
          edited, reopened, or given new prescribers.
        </Banner>
      ) : null}

      <Section
        title="Overview"
        aside={<Badge tone={statusTone(clinic.status)}>{clinic.status}</Badge>}
      >
        <Card>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted">Fills from</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {clinic.sites.length === 0 ? (
                    <span className="text-subtle">—</span>
                  ) : (
                    clinic.sites.map((site) => (
                      <Badge key={site.siteCode} tone={site.isPrimary ? "brand" : "neutral"}>
                        {site.siteCode}
                        {site.isPrimary ? " · primary" : ""}
                      </Badge>
                    ))
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Patients</dt>
                <dd className="mt-1 font-medium text-fg">{clinic.patientCount}</dd>
              </div>
              <div>
                <dt className="text-muted">Orders</dt>
                <dd className="mt-1 font-medium text-fg">{clinic.orderCount}</dd>
              </div>
              <div>
                <dt className="text-muted">In flight</dt>
                <dd className="mt-1 font-medium text-fg">{clinic.inFlightOrderCount}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </Section>

      <Section title="Prescribers" count={clinic.activeProviders.length}>
        {clinic.activeProviders.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-sm text-muted">
                No prescriber may write for this client yet. Until one is affiliated, prescriptions
                cannot be attributed to it.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Table>
            <THead>
              <TH>Prescriber</TH>
              <TH>NPI</TH>
              <TH>Prescriber status</TH>
              <TH>Since</TH>
              {canAffiliate && !archived ? <TH align="right">Access</TH> : null}
            </THead>
            <TBody>
              {clinic.activeProviders.map((row) => (
                <TR key={row.affiliationId}>
                  <TD className="font-medium">{row.displayName}</TD>
                  <TD className="font-mono text-xs">{row.npi}</TD>
                  <TD>
                    <Badge tone={providerTone(row.providerStatus)}>{row.providerStatus}</Badge>
                  </TD>
                  <TD>{row.affiliatedAt.toLocaleDateString("en-US")}</TD>
                  {canAffiliate && !archived ? (
                    <TD align="right">
                      <ActionForm
                        action={`/api/ops/admin/practices/${clinic.clinicId}/end-affiliation`}
                        confirm={`End ${row.displayName}'s access to ${clinic.name}? Any portal session they have open for this client is signed out immediately.`}
                        className="flex items-center justify-end gap-2"
                      >
                        <input type="hidden" name="providerId" value={row.providerId} />
                        <Input
                          name="reason"
                          required
                          maxLength={500}
                          placeholder="Reason"
                          aria-label={`Reason for ending ${row.displayName}'s access`}
                          className="w-48"
                        />
                        <SubmitButton variant="danger" size="sm" icon="x">
                          End access
                        </SubmitButton>
                      </ActionForm>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {canAffiliate && !archived ? (
          <Card className="mt-4">
            <CardContent>
              {clinic.affiliatableProviders.length === 0 ? (
                <p className="text-sm text-muted">
                  Every active prescriber in the organization already writes for this client.
                  Register a new prescriber first to add one.
                </p>
              ) : (
                <ActionForm
                  action={`/api/ops/admin/practices/${clinic.clinicId}/affiliate-provider`}
                  className="flex flex-wrap items-end gap-3"
                >
                  <Field label="Add a prescriber" className="min-w-64">
                    <Select name="providerId" required defaultValue="">
                      <option value="" disabled>
                        Select a prescriber…
                      </option>
                      {clinic.affiliatableProviders.map((p) => (
                        <option key={p.providerId} value={p.providerId}>
                          {p.displayName} · {p.npi}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton variant="go" icon="plus">
                    Grant access
                  </SubmitButton>
                </ActionForm>
              )}
            </CardContent>
          </Card>
        ) : null}
      </Section>

      {clinic.endedProviders.length > 0 ? (
        <Section title="Former prescribers" count={clinic.endedProviders.length}>
          <Table>
            <THead>
              <TH>Prescriber</TH>
              <TH>NPI</TH>
              <TH>Ended</TH>
              <TH>Reason</TH>
            </THead>
            <TBody>
              {clinic.endedProviders.map((row) => (
                <TR key={row.affiliationId}>
                  <TD className="font-medium">{row.displayName}</TD>
                  <TD className="font-mono text-xs">{row.npi}</TD>
                  <TD>{row.endedAt.toLocaleDateString("en-US")}</TD>
                  <TD className="text-muted">{row.endedReason}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      ) : null}

      {!archived && (canUpdate || canSetStatus) ? (
        <Section title="Manage">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {canUpdate ? (
              <Card>
                <CardContent>
                  <ActionForm
                    action={`/api/ops/admin/practices/${clinic.clinicId}/update`}
                    className="space-y-3"
                  >
                    <Field
                      label="Name"
                      help="The code cannot change — invoices and prescriptions cite it."
                    >
                      <Input name="name" required maxLength={200} defaultValue={clinic.name} />
                    </Field>
                    <SubmitButton icon="check">Save name</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}

            {canSetStatus && transitions.length > 0 ? (
              <Card>
                <CardContent>
                  <ActionForm
                    action={`/api/ops/admin/practices/${clinic.clinicId}/set-status`}
                    confirm={`Change ${clinic.name}'s status? Deactivating or archiving signs every prescriber out of this client's portal immediately.`}
                    className="space-y-3"
                  >
                    <Field
                      label="Status"
                      help={
                        clinic.inFlightOrderCount > 0
                          ? `Archiving is blocked while ${clinic.inFlightOrderCount} order(s) are in flight.`
                          : "Deactivating stops new intake and signs prescribers out of this client."
                      }
                    >
                      <Select name="status" required defaultValue={transitions[0]}>
                        {transitions.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_ACTION_LABELS[status]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Reason">
                      <Input
                        name="reason"
                        required
                        maxLength={500}
                        placeholder="Contract ended 2026-08-31"
                      />
                    </Field>
                    <SubmitButton variant="danger" icon="alert">
                      Apply status change
                    </SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
