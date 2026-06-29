// /ops/admin/sites — pharmacy site admin.
//
// Lists every PharmacySite with an inline edit form per site for the
// ship-from address (plaintext business address; non-PHI). The form
// posts to UpdatePharmacySiteAddress. `addressComplete` drives a badge
// so an operator sees which sites are ready for carrier auto-purchase.
//
// Permission gate: `org.manage_sites`.

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listPharmacySites,
  type PharmacySiteRow,
} from "../../../../src/server/ops/list-pharmacy-sites.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, Input } from "../../../../src/components/ui/field.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

function SiteForm({ site }: { readonly site: PharmacySiteRow }) {
  return (
    <Card>
      <CardHeader>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-fg">{site.code}</span>
            <span className="text-sm text-muted">{site.name}</span>
            <Badge tone={site.status === "ACTIVE" ? "success" : "neutral"}>{site.status}</Badge>
            <Badge tone={site.addressComplete ? "success" : "warning"}>
              {site.addressComplete ? "address complete" : "needs address"}
            </Badge>
          </div>
          <div className="text-xs text-subtle">timezone {site.timezone}</div>
        </div>
      </CardHeader>
      <CardContent>
        <ActionForm
          action={`/api/ops/admin/sites/${site.siteId}/update-address`}
          className="space-y-3"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Address line 1" required className="sm:col-span-2">
              <Input
                type="text"
                name="addressLine1"
                required
                maxLength={200}
                defaultValue={site.addressLine1 ?? ""}
              />
            </Field>
            <Field label="Address line 2" className="sm:col-span-2">
              <Input
                type="text"
                name="addressLine2"
                maxLength={200}
                defaultValue={site.addressLine2 ?? ""}
              />
            </Field>
            <Field label="City" required>
              <Input
                type="text"
                name="city"
                required
                maxLength={100}
                defaultValue={site.city ?? ""}
              />
            </Field>
            <Field label="State" required>
              <Input
                type="text"
                name="state"
                required
                maxLength={80}
                defaultValue={site.state ?? ""}
              />
            </Field>
            <Field label="Postal code" required>
              <Input
                type="text"
                name="postalCode"
                required
                maxLength={20}
                defaultValue={site.postalCode ?? ""}
              />
            </Field>
            <Field label="Country" help="ISO 3166-1 alpha-2" required>
              <Input
                type="text"
                name="country"
                required
                maxLength={2}
                defaultValue={site.country}
                className="font-mono uppercase"
              />
            </Field>
            <Field label="Phone" help="Required by some carriers" className="sm:col-span-2">
              <Input type="tel" name="phone" maxLength={40} defaultValue={site.phone ?? ""} />
            </Field>
          </div>
          <SubmitButton icon="check">Save address</SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

export default async function SiteAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORG_MANAGE_SITES)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Sites" />
        <PermissionDenied grant="org.manage_sites" />
      </div>
    );
  }

  const sites = await listPharmacySites({ organizationId: session.tenancy.organizationId });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Pharmacy sites"
        description="The ship-from address here drives the carrier auto-purchase flow. Sites without a complete address fall back to manual shipment entry."
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      {sites.length === 0 ? (
        <EmptyState
          icon="sites"
          title="No pharmacy sites configured"
          description="Run CreateOrganization or seed a site first."
        />
      ) : (
        <Section title="Sites" count={sites.length}>
          <div className="space-y-4">
            {sites.map((site) => (
              <SiteForm key={site.siteId} site={site} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
