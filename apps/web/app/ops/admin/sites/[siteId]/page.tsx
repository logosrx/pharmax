// /ops/admin/sites/[siteId] — the pharmacy's own credentials and the
// states it may dispense into. Go-live G-1 and G-2.
//
// The page leads with whether ship-to-state enforcement is ON, because
// that is the non-obvious part: a site with no authorized states has
// asserted nothing about its licensure, so shipping is NOT restricted
// for it. An operator who has just recorded four licences would
// otherwise reasonably assume they were protected. They are not until
// they declare the states.
//
// Turning enforcement on is a refusal-generating act, so the page shows
// what it would refuse before it is switched on — orders already bound
// for states outside the proposed set, and orders with no recorded
// destination at all. Finding that out from a stuck queue instead is
// the failure this section exists to avoid.
//
// The states form is a checkbox set over LICENSED states only, because
// `SetSiteAuthorizedShipStates` refuses any state without a live
// licence behind it. A free-text field here would just fail on submit.
//
// PHI: none. Order figures are aggregate counts.

import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CredentialVerificationMethod,
  SiteCredentialKind,
  type SiteStatus,
} from "@pharmax/database";
import { geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { getSiteCredentials } from "../../../../../src/server/ops/get-site-credentials.js";
import type { CredentialStanding } from "../../../../../src/server/ops/get-provider-credentials.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../../src/components/ui/data.js";
import { Badge, type Tone } from "../../../../../src/components/ui/badge.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

function standingTone(standing: CredentialStanding): Tone {
  switch (standing) {
    case "ACTIVE":
      return "success";
    case "EXPIRED":
    case "REVOKED":
      return "danger";
    case "SUSPENDED":
    case "NO_EXPIRY":
      return "warning";
    default: {
      const exhaustive: never = standing;
      return exhaustive;
    }
  }
}

function standingLabel(standing: CredentialStanding): string {
  switch (standing) {
    case "ACTIVE":
      return "Active";
    case "EXPIRED":
      return "Expired";
    case "REVOKED":
      return "Revoked";
    case "SUSPENDED":
      return "Suspended";
    case "NO_EXPIRY":
      return "No expiry on file";
    default: {
      const exhaustive: never = standing;
      return exhaustive;
    }
  }
}

function siteTone(status: SiteStatus): Tone {
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

const KIND_LABELS: Readonly<Record<SiteCredentialKind, string>> = {
  STATE_PHARMACY_LICENSE: "State pharmacy licence",
  DEA_REGISTRATION: "DEA registration",
  NPI: "NPI",
  NCPDP: "NCPDP",
  NABP: "NABP / e-Profile",
};

const CREDENTIAL_KINDS = [
  SiteCredentialKind.STATE_PHARMACY_LICENSE,
  SiteCredentialKind.DEA_REGISTRATION,
  SiteCredentialKind.NPI,
  SiteCredentialKind.NCPDP,
  SiteCredentialKind.NABP,
] as const;

const VERIFICATION_LABELS: Readonly<Record<CredentialVerificationMethod, string>> = {
  ATTESTED: "Attested",
  PORTAL_CHECKED: "Checked in registry portal",
  REGISTRY_FILE: "From registry file",
};

function formatDate(value: Date | null): string {
  return value === null ? "—" : value.toLocaleDateString("en-US");
}

export default async function SiteCredentialsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly siteId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { siteId } = await params;
  const query = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  // Matches the sites list page: there is no separate read grant for
  // sites, so `org.manage_sites` is the gate for seeing one.
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORG_MANAGE_SITES)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Organization" title="Pharmacy site" />
        <PermissionDenied grant="org.manage_sites" />
      </div>
    );
  }

  const site = await getSiteCredentials({
    organizationId: session.tenancy.organizationId,
    siteId,
  });
  if (site === null) notFound();

  const canManageCredentials = hasOperatorPermission(
    permissions,
    PERMISSIONS.ORG_SITE_CREDENTIALS_MANAGE
  );
  const canManageShipStates = hasOperatorPermission(
    permissions,
    PERMISSIONS.ORG_SHIP_STATES_MANAGE
  );

  const flash = typeof query["flash"] === "string" ? query["flash"] : null;
  const flashError = typeof query["error"] === "string" ? query["error"] : null;

  const authorized = new Set(site.authorizedShipStates.map((s) => s.state));
  // Every state that can appear in the picker: already authorized, plus
  // those with a live licence not yet authorized.
  const selectableStates = [...new Set([...authorized, ...site.licensableStates])].sort();
  const lapsedAuthorizations = site.authorizedShipStates.filter(
    (s) => s.licenseStanding === "EXPIRED" || s.licenseStanding === "REVOKED"
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/sites"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to sites
      </Link>

      <PageHeader eyebrow="Pharmacy site" title={site.name} description={`Code ${site.code}`} />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="Action failed">
          {flashError}
        </Banner>
      ) : null}

      {/* The fact most likely to be misread. See the file header. */}
      {site.enforcementActive ? (
        <Banner tone="success" title="Ship-to-state enforcement is active">
          Shipments from this site are refused for any destination outside the{" "}
          {site.authorizedShipStates.length} licensed state
          {site.authorizedShipStates.length === 1 ? "" : "s"} below, and for any order whose
          destination state is unknown.
        </Banner>
      ) : (
        <Banner tone="warning" title="Ship-to-state enforcement is OFF for this site">
          No licensed states are declared, so shipping from this site is not restricted by
          licensure. Recording licences alone does not enable enforcement — declare the states
          below.
        </Banner>
      )}

      {lapsedAuthorizations.length > 0 ? (
        <Banner tone="danger" title="Authorized on a licence that is no longer live">
          {lapsedAuthorizations.map((s) => s.state).join(", ")} remain authorized while the
          underlying licence has lapsed. Shipments are still permitted — remove the state or renew
          the licence.
        </Banner>
      ) : null}

      <Section title="Overview" aside={<Badge tone={siteTone(site.status)}>{site.status}</Badge>}>
        <Card>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted">Credentials</dt>
                <dd className="mt-1 font-medium text-fg">{site.credentials.length}</dd>
              </div>
              <div>
                <dt className="text-muted">Licensed states</dt>
                <dd className="mt-1 font-medium text-fg">{site.authorizedShipStates.length}</dd>
              </div>
              <div>
                <dt className="text-muted">Open orders out of state</dt>
                <dd className="mt-1 font-medium text-fg">
                  {site.enforcementActive ? site.ordersToUnlicensedStates : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Open orders, destination unknown</dt>
                <dd className="mt-1 font-medium text-fg">{site.ordersWithNoDestination}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </Section>

      <Section title="Regulatory credentials" count={site.credentials.length}>
        {site.credentials.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-sm text-muted">
                No credentials recorded. A state pharmacy licence has to be on file before this site
                can be authorized to dispense into that state.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Table>
            <THead>
              <TH>Kind</TH>
              <TH>State</TH>
              <TH>Number</TH>
              <TH>Expires</TH>
              <TH>Standing</TH>
              <TH>Verification</TH>
            </THead>
            <TBody>
              {site.credentials.map((c) => (
                <TR key={c.credentialId}>
                  <TD className="font-medium">{KIND_LABELS[c.kind]}</TD>
                  <TD>{c.state ?? "—"}</TD>
                  <TD className="font-mono text-xs">{c.identifier}</TD>
                  <TD>{formatDate(c.expiresAt)}</TD>
                  <TD>
                    <Badge tone={standingTone(c.standing)}>{standingLabel(c.standing)}</Badge>
                  </TD>
                  <TD className="text-muted">{VERIFICATION_LABELS[c.verificationMethod]}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {canManageCredentials ? (
          <Card className="mt-4">
            <CardContent>
              <ActionForm
                action={`/api/ops/admin/sites/${site.siteId}/record-credential`}
                className="flex flex-wrap items-end gap-3"
              >
                <Field label="Kind">
                  <Select name="kind" required defaultValue="">
                    <option value="" disabled>
                      Select…
                    </option>
                    {CREDENTIAL_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="State" help="Required for a state pharmacy licence only.">
                  <Select name="state" defaultValue="">
                    <option value="">Not applicable</option>
                    {geo.US_JURISDICTION_CODES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Number" help="Recording the same kind and state again renews it.">
                  <Input name="identifier" required maxLength={64} className="w-44 font-mono" />
                </Field>
                <Field label="Expires">
                  <Input name="expiresAt" type="date" className="w-40" />
                </Field>
                <Field label="Verification">
                  <Select
                    name="verificationMethod"
                    defaultValue={CredentialVerificationMethod.ATTESTED}
                  >
                    {(
                      [
                        CredentialVerificationMethod.ATTESTED,
                        CredentialVerificationMethod.PORTAL_CHECKED,
                        CredentialVerificationMethod.REGISTRY_FILE,
                      ] as const
                    ).map((m) => (
                      <option key={m} value={m}>
                        {VERIFICATION_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton variant="go" icon="plus">
                  Record credential
                </SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </Section>

      <Section title="Licensed to dispense into" count={site.authorizedShipStates.length}>
        {site.authorizedShipStates.length > 0 ? (
          <Table>
            <THead>
              <TH>State</TH>
              <TH>Licence cited</TH>
              <TH>Licence standing</TH>
            </THead>
            <TBody>
              {site.authorizedShipStates.map((s) => (
                <TR key={s.state}>
                  <TD className="font-medium">{s.state}</TD>
                  <TD className="font-mono text-xs">{s.licenseIdentifier}</TD>
                  <TD>
                    <Badge tone={standingTone(s.licenseStanding)}>
                      {standingLabel(s.licenseStanding)}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : null}

        {canManageShipStates ? (
          <Card className="mt-4">
            <CardContent>
              {selectableStates.length === 0 ? (
                <p className="text-sm text-muted">
                  No live state pharmacy licence is on file, so there is no state this site can be
                  authorized for. Record a licence above first.
                </p>
              ) : (
                <ActionForm
                  action={`/api/ops/admin/sites/${site.siteId}/set-ship-states`}
                  confirm={
                    site.enforcementActive
                      ? "Replace the licensed states for this site? Shipments to any state left unchecked are refused from now on."
                      : `Turn on ship-to-state enforcement for this site? Shipments to unchecked states are refused from now on, including ${site.ordersWithNoDestination} open order(s) whose destination is unknown.`
                  }
                  className="space-y-3"
                >
                  {/* Declarative: the complete resulting set is posted,
                      so an unchecked box is a withdrawal, not a no-op. */}
                  <fieldset>
                    <legend className="text-sm font-medium text-fg">
                      States this site may dispense into
                    </legend>
                    <p className="mt-0.5 text-xs text-muted">
                      Only states with a live pharmacy licence appear here. Unchecking every box
                      switches enforcement off for this site.
                    </p>
                    <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-8">
                      {selectableStates.map((code) => (
                        <label key={code} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="states"
                            value={code}
                            defaultChecked={authorized.has(code)}
                            className="size-4 rounded border-line accent-brand"
                          />
                          {code}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <Field label="Reason">
                    <Input
                      name="reason"
                      required
                      maxLength={500}
                      placeholder="Added NV licence 2026-08-20"
                      className="max-w-md"
                    />
                  </Field>
                  <SubmitButton variant="danger" icon="alert">
                    Save licensed states
                  </SubmitButton>
                </ActionForm>
              )}
            </CardContent>
          </Card>
        ) : null}
      </Section>
    </div>
  );
}
