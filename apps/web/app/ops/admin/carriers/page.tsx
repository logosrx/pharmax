// /ops/admin/carriers — carrier credential admin.
//
// Lists registered per-org carrier credentials (ACTIVE + DISABLED, for
// rotation history) and renders one "register new" form per provider.
// The RegisterCarrierCredential command envelope-encrypts the API key
// + webhook secret and disables the prior ACTIVE credential for the
// same provider. Keys are NEVER displayed after registration.
//
// Permission gate: `ship.manage_carrier_credentials`.

import { ShippingProvider } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listCarrierCredentials } from "../../../../src/server/ops/list-carrier-credentials.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, Input } from "../../../../src/components/ui/field.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function RegisterForm({
  provider,
  hint,
}: {
  readonly provider: ShippingProvider;
  readonly hint: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{provider}</CardTitle>
        <span className="text-xs text-subtle">{hint}</span>
      </CardHeader>
      <CardContent>
        <ActionForm action="/api/ops/admin/carriers/register" className="space-y-3">
          <input type="hidden" name="provider" value={provider} />
          <Field label="API key" help="Use key:secret for FedEx / UPS" required>
            <Input
              type="password"
              name="apiKey"
              required
              autoComplete="off"
              className="font-mono"
              placeholder="encrypted before persist"
            />
          </Field>
          <Field label="Webhook signing secret">
            <Input
              type="password"
              name="webhookSecret"
              autoComplete="off"
              className="font-mono"
              placeholder="for inbound webhook verification"
            />
          </Field>
          <Field label="Carrier account id">
            <Input
              type="text"
              name="carrierAccountId"
              autoComplete="off"
              className="font-mono"
              placeholder="FedEx / UPS shipper #"
            />
          </Field>
          <Field label="Base URL override">
            <Input
              type="url"
              name="baseUrl"
              autoComplete="off"
              className="font-mono"
              placeholder="blank = default"
            />
          </Field>
          <Field label="Notes">
            <Input type="text" name="notes" maxLength={500} placeholder="e.g. rotated by admin" />
          </Field>
          <SubmitButton icon="carriers" className="w-full">
            Register {provider}
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

export default async function CarrierAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Carriers" />
        <PermissionDenied grant="ship.manage_carrier_credentials" />
      </div>
    );
  }

  const credentials = await listCarrierCredentials({
    organizationId: session.tenancy.organizationId,
  });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Carrier credentials"
        description="Per-organization API keys for the EasyPost / FedEx / UPS adapters. Registering a new credential disables any prior active one for the same provider. Keys are encrypted at rest and never displayed again."
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      <Section title="Registered" count={credentials.length}>
        {credentials.length === 0 ? (
          <EmptyState
            icon="carriers"
            title="No credentials registered"
            description="Use a form below to plug in your first carrier."
          />
        ) : (
          <div className="space-y-2">
            {credentials.map((c) => (
              <Card key={c.credentialId}>
                <CardContent className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium text-fg">{c.provider}</span>
                    <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status}</Badge>
                    {c.hasWebhookSecret ? (
                      <span className="text-xs text-subtle">+ webhook signing secret</span>
                    ) : null}
                  </div>
                  <div className="text-xs text-subtle">
                    Registered {formatDate(c.createdAt)} by <code>{c.createdByUserId}</code>
                    {c.carrierAccountId !== null ? (
                      <>
                        {" "}
                        · account <code className="font-mono">{c.carrierAccountId}</code>
                      </>
                    ) : null}
                    {c.baseUrl !== null ? (
                      <>
                        {" "}
                        · base <code className="font-mono">{c.baseUrl}</code>
                      </>
                    ) : null}
                  </div>
                  {c.notes !== null ? (
                    <div className="text-xs text-subtle">Notes: {c.notes}</div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Register or rotate">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <RegisterForm provider={ShippingProvider.EASYPOST} hint="single API key" />
          <RegisterForm provider={ShippingProvider.FEDEX} hint="key:secret (colon-separated)" />
          <RegisterForm provider={ShippingProvider.UPS} hint="key:secret (colon-separated)" />
        </div>
      </Section>
    </div>
  );
}
