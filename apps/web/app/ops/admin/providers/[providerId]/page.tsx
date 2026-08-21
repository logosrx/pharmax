// /ops/admin/providers/[providerId] — prescriber credentials.
//
// The page answers one question first, in a banner, before any table:
// may this prescriber write controlled substances today? That is the
// question `CreatePrescription` asks on every controlled order, and an
// operator chasing a refusal needs the same answer in the same terms.
//
// Two credential kinds live here for a reason. A DEA registration
// authorizes controlled schedules federally; a state licence authorizes
// practising at all. Pharmax gates controlled prescribing on the
// former only — a missing state licence is a credentialing gap to
// chase, not a hard refusal, because the pharmacy's own licensure is
// what governs where a fill may ship. Saying so on the page is what
// stops someone recording a licence and expecting Schedule II to start
// working.
//
// The DEA number is shown in full here and deliberately NOT on the
// roster page, which shows only derived standing. Full numbers are
// gated behind `providers.credentials.read`.
//
// PHI: none. Prescriber identity is public NPI-registry data.

import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ControlledSubstanceSchedule,
  CredentialStatus,
  CredentialVerificationMethod,
  type DeaRegistrantType,
  type ProviderStatus,
} from "@pharmax/database";
import { geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import {
  getProviderCredentials,
  type CredentialStanding,
} from "../../../../../src/server/ops/get-provider-credentials.js";
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
      return "danger";
    case "REVOKED":
      return "danger";
    case "SUSPENDED":
      return "warning";
    case "NO_EXPIRY":
      // Live, but nobody recorded when it lapses. Not a failure — the
      // migration out of the legacy DEA column produced these — but it
      // cannot be renewed on time, so it is not shown as clean either.
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

// Derived from the DEA number's first letter by `validateDeaNumber`, so
// these are classifications rather than operator input.
const REGISTRANT_TYPE_LABELS: Readonly<Record<DeaRegistrantType, string>> = {
  PRACTITIONER: "Practitioner",
  MID_LEVEL_PRACTITIONER: "Mid-level practitioner",
  NARCOTIC_TREATMENT_PROGRAM: "Narcotic treatment program",
  DATA_WAIVED_LEGACY: "Data-waived (legacy X)",
  NON_PRESCRIBING: "Non-prescribing registrant",
};

/** Schedules a DEA registration can authorize. NON_CONTROLLED is not one. */
const CONTROLLED_SCHEDULES = [
  ControlledSubstanceSchedule.CII,
  ControlledSubstanceSchedule.CIII,
  ControlledSubstanceSchedule.CIV,
  ControlledSubstanceSchedule.CV,
] as const;

const VERIFICATION_LABELS: Readonly<Record<CredentialVerificationMethod, string>> = {
  ATTESTED: "Attested",
  PORTAL_CHECKED: "Checked in registry portal",
  REGISTRY_FILE: "From registry file",
};

function formatDate(value: Date | null): string {
  return value === null ? "—" : value.toLocaleDateString("en-US");
}

/** Days until expiry, or null when there is nothing to count down to. */
function daysUntil(expiresAt: Date | null, now: Date): number | null {
  if (expiresAt === null) return null;
  return Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
}

export default async function ProviderCredentialsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly providerId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { providerId } = await params;
  const query = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_CREDENTIALS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Prescriber credentials" />
        <PermissionDenied grant="providers.credentials.read" />
      </div>
    );
  }

  const provider = await getProviderCredentials({
    organizationId: session.tenancy.organizationId,
    providerId,
  });
  if (provider === null) notFound();

  const canManage = hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_CREDENTIALS_MANAGE);
  const flash = typeof query["flash"] === "string" ? query["flash"] : null;
  const flashError = typeof query["error"] === "string" ? query["error"] : null;

  const now = new Date();
  const liveDea = provider.deaRegistrations.filter(
    (r) => r.standing === "ACTIVE" || r.standing === "NO_EXPIRY"
  );
  // Union of schedules across live registrations — the same union
  // `evaluatePrescriberDeaAuthority` considers.
  const authorizedSchedules = new Set(liveDea.flatMap((r) => [...r.authorizedSchedules]));
  const displayName = `${provider.firstName} ${provider.lastName}${
    provider.credential === null ? "" : `, ${provider.credential}`
  }`;

  // Renewal warnings, ordered soonest first. 60 days is the window a
  // board renewal realistically needs.
  const expiringSoon = [...provider.deaRegistrations, ...provider.stateLicenses]
    .map((c) => ({ credential: c, days: daysUntil(c.expiresAt, now) }))
    .filter(
      (x): x is { credential: typeof x.credential; days: number } =>
        x.days !== null && x.days >= 0 && x.days <= 60
    )
    .sort((a, b) => a.days - b.days);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/providers"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to prescribers
      </Link>

      <PageHeader eyebrow="Prescriber" title={displayName} description={`NPI ${provider.npi}`} />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="Action failed">
          {flashError}
        </Banner>
      ) : null}

      {/* The controlled-substance verdict, in the terms CreatePrescription
          uses. Leading with this is the point of the page. */}
      {authorizedSchedules.size === 0 ? (
        <Banner tone="danger" title="Cannot write controlled substances">
          No live DEA registration is on file, so a controlled prescription for this prescriber will
          be refused at intake. Non-controlled prescriptions are unaffected.
        </Banner>
      ) : (
        <Banner tone="success" title="Authorized for controlled substances">
          Schedules {CONTROLLED_SCHEDULES.filter((s) => authorizedSchedules.has(s)).join(", ")} may
          be written. Anything outside that set is refused at intake.
        </Banner>
      )}

      {expiringSoon.length > 0 ? (
        <Banner tone="warning" title="Renewal due">
          {expiringSoon
            .map(
              (x) =>
                `${
                  "deaNumber" in x.credential
                    ? `DEA ${x.credential.deaNumber}`
                    : `${x.credential.state} licence`
                } expires in ${x.days} day${x.days === 1 ? "" : "s"}`
            )
            .join("; ")}
          .
        </Banner>
      ) : null}

      <Section
        title="Overview"
        aside={<Badge tone={providerTone(provider.status)}>{provider.status}</Badge>}
      >
        <Card>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted">NPI</dt>
                <dd className="mt-1 font-mono text-xs text-fg">{provider.npi}</dd>
              </div>
              <div>
                <dt className="text-muted">DEA registrations</dt>
                <dd className="mt-1 font-medium text-fg">
                  {liveDea.length} live
                  {provider.deaRegistrations.length > liveDea.length
                    ? ` · ${provider.deaRegistrations.length - liveDea.length} lapsed`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className="text-muted">State licences</dt>
                <dd className="mt-1 font-medium text-fg">{provider.stateLicenses.length}</dd>
              </div>
              <div>
                <dt className="text-muted">Writes for</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {provider.activeClinics.length === 0 ? (
                    <span className="text-subtle">No client</span>
                  ) : (
                    provider.activeClinics.map((c) => (
                      <Badge key={c.code} tone="neutral">
                        {c.code}
                      </Badge>
                    ))
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </Section>

      <Section title="DEA registrations" count={provider.deaRegistrations.length}>
        {provider.deaRegistrations.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-sm text-muted">
                No DEA registration on file. Record one to allow controlled prescriptions for this
                prescriber.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Table>
            <THead>
              <TH>DEA number</TH>
              <TH>Registrant type</TH>
              <TH>Schedules</TH>
              <TH>Expires</TH>
              <TH>Standing</TH>
              <TH>Source</TH>
              {canManage ? <TH align="right">Withdraw</TH> : null}
            </THead>
            <TBody>
              {provider.deaRegistrations.map((r) => (
                <TR key={r.registrationId}>
                  <TD className="font-mono text-xs font-medium">{r.deaNumber}</TD>
                  <TD>{REGISTRANT_TYPE_LABELS[r.registrantType]}</TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {r.authorizedSchedules.map((s) => (
                        <Badge key={s} tone="neutral">
                          {s}
                        </Badge>
                      ))}
                    </span>
                  </TD>
                  <TD>{formatDate(r.expiresAt)}</TD>
                  <TD>
                    <Badge tone={standingTone(r.standing)}>{standingLabel(r.standing)}</Badge>
                  </TD>
                  <TD className="text-muted">
                    {r.recordedByEmail ?? "Migrated"} · {VERIFICATION_LABELS[r.verificationMethod]}
                  </TD>
                  {canManage ? (
                    <TD align="right">
                      {r.standing === "REVOKED" ? (
                        <span className="text-subtle">—</span>
                      ) : (
                        <ActionForm
                          action={`/api/ops/admin/providers/${provider.providerId}/revoke-credential`}
                          confirm={`Revoke DEA ${r.deaNumber}? Controlled prescriptions relying on it are refused from now on. Orders already in flight are not affected.`}
                          className="flex items-center justify-end gap-2"
                        >
                          <input type="hidden" name="credentialKind" value="DEA_REGISTRATION" />
                          <input type="hidden" name="credentialId" value={r.registrationId} />
                          <input type="hidden" name="toStatus" value={CredentialStatus.REVOKED} />
                          <Input
                            name="reason"
                            required
                            maxLength={500}
                            placeholder="Reason"
                            aria-label={`Reason for revoking DEA ${r.deaNumber}`}
                            className="w-40"
                          />
                          <SubmitButton variant="danger" size="sm" icon="x">
                            Revoke
                          </SubmitButton>
                        </ActionForm>
                      )}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {canManage ? (
          <Card className="mt-4">
            <CardContent>
              <ActionForm
                action={`/api/ops/admin/providers/${provider.providerId}/record-dea`}
                className="space-y-3"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <Field
                    label="DEA number"
                    help="Checked offline against the DEA checksum. Recording the same number again renews it."
                  >
                    <Input
                      name="deaNumber"
                      required
                      maxLength={9}
                      placeholder="AB1234563"
                      className="w-36 font-mono"
                    />
                  </Field>
                  <Field label="Expires" help="Leave blank only if genuinely unknown.">
                    <Input name="expiresAt" type="date" className="w-40" />
                  </Field>
                  <Field label="Issuing state">
                    <Select name="issuedState" defaultValue="">
                      <option value="">Not recorded</option>
                      {geo.US_JURISDICTION_CODES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </Select>
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
                </div>

                {/* No default. A registration that silently authorized
                    Schedule II because the operator skipped this group
                    is the failure this form is shaped to prevent. */}
                <fieldset>
                  <legend className="text-sm font-medium text-fg">Authorized schedules</legend>
                  <p className="mt-0.5 text-xs text-muted">
                    Select every schedule this registration covers. Anything unchecked is refused at
                    intake.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {CONTROLLED_SCHEDULES.map((s) => (
                      <label key={s} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="authorizedSchedules"
                          value={s}
                          className="size-4 rounded border-line accent-brand"
                        />
                        {s}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <SubmitButton variant="go" icon="plus">
                  Record DEA registration
                </SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </Section>

      <Section title="State licences" count={provider.stateLicenses.length}>
        {provider.stateLicenses.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-sm text-muted">
                No state licence on file. This does not block prescribing — Pharmax gates controlled
                orders on the DEA registration and shipping on the pharmacy&apos;s own licensure —
                but a board audit will ask for it.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Table>
            <THead>
              <TH>State</TH>
              <TH>Licence number</TH>
              <TH>Type</TH>
              <TH>Expires</TH>
              <TH>Standing</TH>
              {canManage ? <TH align="right">Withdraw</TH> : null}
            </THead>
            <TBody>
              {provider.stateLicenses.map((l) => (
                <TR key={l.licenseId}>
                  <TD className="font-medium">{l.state}</TD>
                  <TD className="font-mono text-xs">{l.licenseNumber}</TD>
                  <TD>{l.licenseType ?? "—"}</TD>
                  <TD>{formatDate(l.expiresAt)}</TD>
                  <TD>
                    <Badge tone={standingTone(l.standing)}>{standingLabel(l.standing)}</Badge>
                  </TD>
                  {canManage ? (
                    <TD align="right">
                      {l.standing === "REVOKED" ? (
                        <span className="text-subtle">—</span>
                      ) : (
                        <ActionForm
                          action={`/api/ops/admin/providers/${provider.providerId}/revoke-credential`}
                          confirm={`Revoke the ${l.state} licence ${l.licenseNumber}?`}
                          className="flex items-center justify-end gap-2"
                        >
                          <input type="hidden" name="credentialKind" value="STATE_LICENSE" />
                          <input type="hidden" name="credentialId" value={l.licenseId} />
                          <input type="hidden" name="toStatus" value={CredentialStatus.REVOKED} />
                          <Input
                            name="reason"
                            required
                            maxLength={500}
                            placeholder="Reason"
                            aria-label={`Reason for revoking the ${l.state} licence`}
                            className="w-40"
                          />
                          <SubmitButton variant="danger" size="sm" icon="x">
                            Revoke
                          </SubmitButton>
                        </ActionForm>
                      )}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {canManage ? (
          <Card className="mt-4">
            <CardContent>
              <ActionForm
                action={`/api/ops/admin/providers/${provider.providerId}/record-license`}
                className="flex flex-wrap items-end gap-3"
              >
                <Field label="State">
                  <Select name="state" required defaultValue="">
                    <option value="" disabled>
                      Select…
                    </option>
                    {geo.US_JURISDICTION_CODES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Licence number" help="Recording the same state again renews it.">
                  <Input name="licenseNumber" required maxLength={64} className="w-40 font-mono" />
                </Field>
                <Field label="Type">
                  <Input name="licenseType" maxLength={64} placeholder="MD" className="w-28" />
                </Field>
                <Field label="Expires">
                  <Input name="expiresAt" type="date" className="w-40" />
                </Field>
                <SubmitButton variant="go" icon="plus">
                  Record licence
                </SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </Section>
    </div>
  );
}
