// /ops/admin/practices/new — onboard a client practice.
//
// Until CreateClinic existed, the only code that created a clinic was
// prisma/seed.ts, so bringing on a real customer's practice meant a
// hand-written INSERT. This is the form that replaces it.
//
// At least one pharmacy site is required: a client no site can fill for
// cannot receive an order, so creating one would produce a row that
// looks onboarded and is not. The first site checked becomes primary.
//
// Permission gate: `clinics.create`. Directory data only — no PHI.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { listPharmacySites } from "../../../../../src/server/ops/list-pharmacy-sites.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input } from "../../../../../src/components/ui/field.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

export default async function NewPracticePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.CLINICS_CREATE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="New client" />
        <PermissionDenied grant="clinics.create" />
      </div>
    );
  }

  const sites = await listPharmacySites({ organizationId: session.tenancy.organizationId });
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

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
        eyebrow="Directory"
        title="New client"
        description="A client is a practice that sends you prescriptions. It is the billing counterparty for every order placed under it and the boundary its patient roster lives in, so the code you choose here appears on their invoices."
      />

      {flashError !== null ? (
        <Banner tone="danger" title="Client was not created">
          {flashError}
        </Banner>
      ) : null}

      {sites.length === 0 ? (
        <EmptyState
          icon="practices"
          title="No pharmacy sites configured"
          description="A client has to be fillable from at least one pharmacy site. Add a site before onboarding a client."
        />
      ) : (
        <Card>
          <CardContent>
            <ActionForm action="/api/ops/admin/practices/create" className="space-y-6">
              <Section title="Client">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label="Code"
                    help="Immutable once issued — invoices and prescriptions cite it. Letters, digits, dash or underscore."
                  >
                    <Input
                      name="code"
                      required
                      maxLength={32}
                      autoComplete="off"
                      className="font-mono uppercase"
                      placeholder="VALLEY-WELLNESS"
                    />
                  </Field>
                  <Field label="Name" help="How the practice appears on screens and invoices">
                    <Input
                      name="name"
                      required
                      maxLength={200}
                      autoComplete="off"
                      placeholder="Valley Wellness Clinic"
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Fills from">
                <p className="mb-3 text-sm text-muted">
                  Which pharmacy sites may fill for this client. The first one selected becomes the
                  primary.
                </p>
                <ul className="space-y-2">
                  {sites.map((site, index) => (
                    <li key={site.siteId} className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        id={`site-${site.siteId}`}
                        name="siteIds"
                        value={site.siteId}
                        defaultChecked={index === 0}
                        className="mt-0.5 h-4 w-4 rounded border-line-strong"
                      />
                      <label htmlFor={`site-${site.siteId}`} className="text-sm">
                        <span className="font-medium text-fg">{site.name}</span>{" "}
                        <span className="font-mono text-xs text-muted">{site.code}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </Section>

              <SubmitButton variant="go" icon="check">
                Onboard client
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
