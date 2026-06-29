// /ops/admin/patients/[patientId] — patient detail + edit + crypto-shred.
//
// Mirrors order-detail PHI handling: dispatches a ViewPatient audit
// BEFORE rendering the patient block; if the audit fails the page
// refuses to display PHI (surface=PATIENT_ADMIN_PAGE). Edit
// (UpdatePatient, gated patients.update) supports partial updates;
// identity can't be cleared (use crypto-shred). Crypto-shred
// (gated patients.crypto_shred) is destructive + irreversible and
// renders only when not already shredded.

import Link from "next/link";

import { CRYPTO_SHRED_REASONS } from "@pharmax/crypto";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { auditPatientView } from "../../../../../src/server/ops/audit-patient-view.js";
import { getPatientDetail } from "../../../../../src/server/ops/get-patient-detail.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { DataList } from "../../../../../src/components/ui/data.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

function dash(value: string | null): string {
  return value ?? "—";
}
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function statusTone(status: string): Tone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DECEASED":
    case "MERGED":
      return "warning";
    default:
      return "neutral";
  }
}

export default async function PatientDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly patientId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ patientId }, sp] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Patient detail" />
        <PermissionDenied grant="patients.read" />
      </div>
    );
  }
  const canUpdate = hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_UPDATE);
  const canCryptoShred = hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_CRYPTO_SHRED);

  const detail = await getPatientDetail({
    organizationId: session.tenancy.organizationId,
    patientId,
  });
  if (detail === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Patient not found" />
        <EmptyState
          icon="patients"
          title="This patient doesn't exist in your organization"
          action={
            <Link
              href="/ops/admin/patients"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Back to patient search
            </Link>
          }
        />
      </div>
    );
  }

  const audit = await auditPatientView({
    organizationId: session.tenancy.organizationId,
    operatorUserId: session.operator.userId,
    patientId: detail.patientId,
    surface: "PATIENT_ADMIN_PAGE",
    phiDecryptErrors: detail.phiDecryptErrors,
  });
  if (!audit.ok) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Patient detail" />
        <Banner tone="danger" title="PHI display blocked — audit could not be recorded">
          We could not record a PHI-view audit and have refused to display patient identity.
          Operational fault: <code>{audit.code}</code>. Refresh to retry.
        </Banner>
        <Link
          href="/ops/admin/patients"
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          Back to patient search
        </Link>
      </div>
    );
  }

  const flash = typeof sp["flash"] === "string" ? sp["flash"] : null;
  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  const isShredded = detail.cryptoShreddedAt !== null;
  const fullName = [detail.fields.firstName, detail.fields.middleName, detail.fields.lastName]
    .filter((s) => s !== null && s.length > 0)
    .join(" ");

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/patients"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to patient search
      </Link>

      <PageHeader
        eyebrow={
          <span className="font-mono normal-case tracking-normal text-subtle">
            {detail.patientId}
          </span>
        }
        title={fullName.length === 0 ? "—" : fullName}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(detail.status)} dot>
              {detail.status}
            </Badge>
            <span className="text-xs text-subtle">
              {detail.clinicName} · {detail.orderCount} order{detail.orderCount === 1 ? "" : "s"}
            </span>
          </div>
        }
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      {isShredded ? (
        <Banner tone="warning" title="Patient was crypto-shredded">
          Shredded on <span className="font-mono">{formatDate(detail.cryptoShreddedAt!)}</span>.
          Identity fields are permanently unreadable. Edit + re-shred actions are disabled.
        </Banner>
      ) : null}
      {detail.phiDecryptErrors && !isShredded ? (
        <Banner tone="danger" title="One or more PHI fields failed to decrypt">
          Treat as INCOMPLETE; do not edit until the cause is investigated.
        </Banner>
      ) : null}

      <Section title="Identity">
        <Card>
          <CardContent>
            <DataList
              columns={3}
              items={[
                { label: "First name", value: dash(detail.fields.firstName) },
                { label: "Middle name", value: dash(detail.fields.middleName) },
                { label: "Last name", value: dash(detail.fields.lastName) },
                { label: "Date of birth", value: dash(detail.fields.dateOfBirth) },
                { label: "Sex at birth", value: dash(detail.fields.sexAtBirth) },
                { label: "SSN last 4", value: dash(detail.fields.ssnLast4) },
                { label: "MRN", value: dash(detail.fields.mrn) },
              ]}
            />
          </CardContent>
        </Card>
      </Section>

      <Section title="Contact & address">
        <Card>
          <CardContent>
            <DataList
              columns={3}
              items={[
                { label: "Phone", value: dash(detail.fields.phone) },
                { label: "Email", value: dash(detail.fields.email) },
                { label: "Address line 1", value: dash(detail.fields.addressLine1) },
                { label: "Address line 2", value: dash(detail.fields.addressLine2) },
                { label: "City", value: dash(detail.fields.city) },
                { label: "State", value: dash(detail.fields.state) },
                { label: "Postal code", value: dash(detail.fields.postalCode) },
              ]}
            />
          </CardContent>
        </Card>
      </Section>

      {canUpdate && !isShredded ? (
        <Section title="Edit patient">
          <Card>
            <CardContent>
              <ActionForm
                action={`/api/ops/admin/patients/${detail.patientId}/update`}
                className="space-y-3"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="First name">
                    <Input
                      type="text"
                      name="firstName"
                      defaultValue={detail.fields.firstName ?? ""}
                      maxLength={100}
                    />
                  </Field>
                  <Field label="Middle name">
                    <Input
                      type="text"
                      name="middleName"
                      defaultValue={detail.fields.middleName ?? ""}
                      maxLength={100}
                    />
                  </Field>
                  <Field label="Last name">
                    <Input
                      type="text"
                      name="lastName"
                      defaultValue={detail.fields.lastName ?? ""}
                      maxLength={100}
                    />
                  </Field>
                  <Field label="Date of birth" help="YYYY-MM-DD">
                    <Input
                      type="text"
                      name="dateOfBirth"
                      defaultValue={detail.fields.dateOfBirth ?? ""}
                      placeholder="1985-03-14"
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Phone">
                    <Input type="text" name="phone" defaultValue={detail.fields.phone ?? ""} />
                  </Field>
                  <Field label="Email">
                    <Input type="email" name="email" defaultValue={detail.fields.email ?? ""} />
                  </Field>
                  <Field label="Address line 1" className="sm:col-span-2">
                    <Input
                      type="text"
                      name="addressLine1"
                      defaultValue={detail.fields.addressLine1 ?? ""}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Address line 2">
                    <Input
                      type="text"
                      name="addressLine2"
                      defaultValue={detail.fields.addressLine2 ?? ""}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="City">
                    <Input
                      type="text"
                      name="city"
                      defaultValue={detail.fields.city ?? ""}
                      maxLength={100}
                    />
                  </Field>
                  <Field label="State" help="2-letter code">
                    <Input
                      type="text"
                      name="state"
                      defaultValue={detail.fields.state ?? ""}
                      maxLength={2}
                      className="font-mono uppercase"
                    />
                  </Field>
                  <Field label="Postal code">
                    <Input
                      type="text"
                      name="postalCode"
                      defaultValue={detail.fields.postalCode ?? ""}
                      maxLength={10}
                      className="font-mono"
                    />
                  </Field>
                  <Field label="MRN">
                    <Input
                      type="text"
                      name="mrn"
                      defaultValue={detail.fields.mrn ?? ""}
                      maxLength={64}
                      className="font-mono"
                    />
                  </Field>
                </div>
                <p className="text-xs text-subtle">
                  Saves all non-empty fields. Empty optional fields are left unchanged (use
                  crypto-shred for forget-me). Every field is redacted from{" "}
                  <code>command_log.requestPayload</code> before persist.
                </p>
                <SubmitButton icon="check">Save changes</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </Section>
      ) : null}

      {canCryptoShred && !isShredded ? (
        <Section title="Danger zone">
          <Card accent="danger">
            <CardHeader>
              <CardTitle className="text-red-300">Crypto-shred</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted">
                <strong className="text-fg">Destructive &amp; irreversible.</strong> Renders every
                PHI envelope and blind-index column NULL and destroys the underlying DEK. Order
                references stay intact (FK integrity), but no future read can recover the identity.
              </p>
              <ActionForm
                action={`/api/ops/admin/patients/${detail.patientId}/crypto-shred`}
                confirm="Crypto-shred this patient? This is permanent and irreversible."
                className="flex flex-wrap items-end gap-2"
              >
                <Field label="Reason">
                  <Select name="reason" defaultValue={CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN}>
                    {Object.values(CRYPTO_SHRED_REASONS).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton variant="danger" icon="alert">
                  Crypto-shred this patient
                </SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
