// /ops/prescriptions/new — Rx transcription.
//
// Where a paper or faxed script becomes a `prescription` row. The
// typing queue next door is a workflow surface — claim an order, mark
// it typed — and never captured what a prescription SAYS; this is the
// data entry that produces the thing PV1 later verifies.
//
// Two steps, because a prescription is written for one patient and the
// clinic must come from that patient's own record rather than from a
// picker the operator could get wrong:
//
//   1. Find the patient (PHI-safe blind-index search, same contract as
//      the patient roster page).
//   2. Transcribe against them. The clinic is read off the patient, so
//      a prescription cannot be filed under a practice that does not
//      own them.
//
// PHI surface. Patient identity is decrypted only after `ViewPatient`
// records the view; if that audit fails, the identity is NOT rendered.
// The sig, the notes and the indication are entered here and leave
// only in the POST body — never in a query string, never in a log.

import { ProviderStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import Link from "next/link";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  auditPatientView,
  auditPatientViewsBatch,
} from "../../../../src/server/ops/audit-patient-view.js";
import { getPatientDetail } from "../../../../src/server/ops/get-patient-detail.js";
import { listProviders } from "../../../../src/server/ops/list-providers.js";
import { listTranscribableProducts } from "../../../../src/server/ops/list-transcribable-products.js";
import { SCHEDULE_GUIDANCE } from "../../../../src/server/ops/rx-schedule-guidance.js";
import { searchPatientsForAdmin } from "../../../../src/server/ops/search-patients-for-admin.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, LinkCard } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, inputClass } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { describeCreatePrescriptionError } from "../../../../src/components/ops/rx-transcription-errors.js";
import {
  RxTranscriptionForm,
  type TranscriptionPrescriber,
} from "../../../../src/components/ops/rx-transcription-form.js";

const SUBMIT_ACTION = "/api/ops/prescriptions/create";

function pluck(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function prescriberLabel(provider: {
  readonly lastName: string;
  readonly firstName: string;
  readonly credential: string | null;
  readonly npi: string;
}): string {
  const credential = provider.credential === null ? "" : ` ${provider.credential}`;
  return `${provider.lastName}, ${provider.firstName}${credential} · NPI ${provider.npi}`;
}

export default async function TranscribePrescriptionPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  const header = <PageHeader eyebrow="Intake" title="Transcribe prescription" />;
  if (!hasOperatorPermission(permissions, PERMISSIONS.PRESCRIPTIONS_CREATE)) {
    return (
      <div className="space-y-6">
        {header}
        <PermissionDenied grant="prescriptions.create" role="Technician" />
      </div>
    );
  }
  // Transcription is impossible without seeing who the script is for,
  // and seeing that is a PHI grant of its own.
  if (!hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_READ)) {
    return (
      <div className="space-y-6">
        {header}
        <PermissionDenied grant="patients.read" role="Technician" />
      </div>
    );
  }

  const organizationId = session.tenancy.organizationId;
  const patientId = pluck(params, "patientId");
  const rxNumber = pluck(params, "rxNumber");
  const rawError = pluck(params, "error");
  const failure = rawError === undefined ? null : describeCreatePrescriptionError(rawError);

  const banners = (
    <>
      {rxNumber !== undefined ? (
        <Banner tone="success" title={`Transcribed as ${rxNumber}`}>
          Schedule {pluck(params, "schedule") ?? "—"} · expires{" "}
          <code>{pluck(params, "expiresAt") ?? "—"}</code>. It is ready to be attached to an order.
        </Banner>
      ) : null}
      {failure !== null ? (
        <Banner tone="danger" title={failure.title}>
          <p>{failure.guidance}</p>
          <p className="mt-1 text-xs opacity-80">
            {failure.citation === undefined ? null : <>{failure.citation} · </>}
            <code>{failure.code}</code>
          </p>
        </Banner>
      ) : null}
    </>
  );

  // ---- Step 1: pick the patient ------------------------------------
  if (patientId === undefined) {
    const query = {
      lastName: pluck(params, "lastName"),
      firstName: pluck(params, "firstName"),
      dateOfBirth: pluck(params, "dateOfBirth"),
      mrn: pluck(params, "mrn"),
    };
    const submitted = Object.values(query).some((v) => v !== undefined);

    const results = submitted
      ? await searchPatientsForAdmin({ organizationId, query, includeNonActive: false })
      : null;
    const auditBatch =
      results === null
        ? null
        : await auditPatientViewsBatch({
            organizationId,
            operatorUserId: session.operator.userId,
            surface: "PATIENT_SEARCH_RESULT",
            patients: results.rows.map((r) => ({
              patientId: r.patientId,
              phiDecryptErrors: r.phiDecryptErrors,
            })),
          });

    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          eyebrow="Intake"
          title="Transcribe prescription"
          description="Find the patient the script was written for. The practice, and everything scoped to it, is taken from their record — not chosen here."
        />
        {banners}

        <Card>
          <CardContent>
            <form className="grid grid-cols-1 gap-3 @3xl:grid-cols-5" method="GET">
              <Field label="Last name">
                <input
                  type="text"
                  name="lastName"
                  defaultValue={query.lastName ?? ""}
                  autoComplete="off"
                  className={inputClass()}
                />
              </Field>
              <Field label="First name">
                <input
                  type="text"
                  name="firstName"
                  defaultValue={query.firstName ?? ""}
                  autoComplete="off"
                  className={inputClass()}
                />
              </Field>
              <Field label="Date of birth" help="YYYY-MM-DD">
                <input
                  type="text"
                  name="dateOfBirth"
                  defaultValue={query.dateOfBirth ?? ""}
                  placeholder="1985-03-14"
                  autoComplete="off"
                  className={inputClass("font-mono")}
                />
              </Field>
              <Field label="MRN">
                <input
                  type="text"
                  name="mrn"
                  defaultValue={query.mrn ?? ""}
                  autoComplete="off"
                  className={inputClass("font-mono")}
                />
              </Field>
              <div className="flex items-end">
                <button type="submit" className={buttonClass({ variant: "primary" })}>
                  <Icon name="search" size={16} />
                  Find patient
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        {auditBatch !== null && auditBatch.failedPatientIds.length > 0 ? (
          <Banner tone="danger" title="PHI-view audit incomplete">
            Audit failed for {auditBatch.failedPatientIds.length} of {auditBatch.attempted} results.
            This is a compliance regression; report operator id{" "}
            <code>{session.operator.userId}</code>.
          </Banner>
        ) : null}

        {results === null ? (
          <EmptyState
            icon="search"
            title="Start with the patient"
            description="Only active patients can receive a new prescription, so the search is limited to them."
          />
        ) : results.rows.length === 0 ? (
          <EmptyState
            icon="patients"
            title="No active patient matches"
            description="Check the spelling and the date of birth. A patient who is inactive, deceased, or merged will not appear here and cannot be prescribed for."
          />
        ) : (
          <Section title="Matches" count={results.rows.length} aside={`${results.tookMs}ms`}>
            <div className="space-y-2">
              {results.rows.map((row) => {
                const name = [row.firstName, row.middleName, row.lastName]
                  .filter((s) => s !== null && s.length > 0)
                  .join(" ");
                return (
                  <LinkCard
                    key={row.patientId}
                    href={`/ops/prescriptions/new?patientId=${encodeURIComponent(row.patientId)}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-fg">
                        {name.length === 0 ? "—" : name}
                      </span>
                      <Badge tone="success">{row.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-subtle">
                      DOB <span className="font-mono">{row.dateOfBirth ?? "—"}</span>
                      {row.mrn === null ? null : (
                        <>
                          {" "}
                          · MRN <span className="font-mono">{row.mrn}</span>
                        </>
                      )}
                    </div>
                  </LinkCard>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    );
  }

  // ---- Step 2: transcribe against the chosen patient ---------------
  const patient = await getPatientDetail({ organizationId, patientId });
  const backToSearch = (
    <Link
      href="/ops/prescriptions/new"
      className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
    >
      <Icon name="arrowLeft" size={15} />
      Choose a different patient
    </Link>
  );

  if (patient === null) {
    return (
      <div className="space-y-6 animate-fade-in">
        {backToSearch}
        {header}
        <Banner tone="danger" title="That patient isn't in your organization">
          The link may be stale, or the record may have been merged. Search for the patient again.
        </Banner>
      </div>
    );
  }

  const view = await auditPatientView({
    organizationId,
    operatorUserId: session.operator.userId,
    patientId,
    surface: "PATIENT_ADMIN_PAGE",
    phiDecryptErrors: patient.phiDecryptErrors,
  });
  if (!view.ok) {
    // Every PHI display has an audit row behind it. No row, no
    // display — and no form, because the operator cannot safely
    // transcribe against a patient they have not been shown.
    return (
      <div className="space-y-6 animate-fade-in">
        {backToSearch}
        {header}
        <Banner tone="danger" title="Patient data withheld — the view audit failed">
          Pharmax will not show patient identity it cannot record having shown. Retry in a moment;
          if it persists, report <code>{view.code}</code> to your administrator.
        </Banner>
      </div>
    );
  }

  const [providers, catalog] = await Promise.all([
    listProviders({ organizationId, status: ProviderStatus.ACTIVE, limit: 200 }),
    listTranscribableProducts({ organizationId }),
  ]);

  const prescribers: ReadonlyArray<TranscriptionPrescriber> = providers.rows.map((p) => ({
    providerId: p.providerId,
    label: prescriberLabel(p),
    hasDeaRegistration: p.deaNumber !== null && p.deaNumber.trim().length > 0,
  }));

  const patientName = [patient.fields.firstName, patient.fields.middleName, patient.fields.lastName]
    .filter((s) => s !== null && s.length > 0)
    .join(" ");
  // The command compares the date written against the start of the
  // UTC day, so the form's ceiling has to be the same calendar.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6 animate-fade-in">
      {backToSearch}
      <PageHeader
        eyebrow="Intake"
        title="Transcribe prescription"
        description="Everything below is checked again by the command that writes it. Backend validation is the source of truth; the hints here only save you a round trip."
      />
      {banners}

      <Card accent="brand">
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">
              {patientName.length === 0 ? "—" : patientName}
            </span>
            <Badge tone="success">{patient.status}</Badge>
            {patient.phiDecryptErrors ? <Badge tone="danger">decrypt errors</Badge> : null}
          </div>
          <div className="mt-1 text-xs text-subtle">
            DOB <span className="font-mono">{patient.fields.dateOfBirth ?? "—"}</span>
            {patient.fields.mrn === null ? null : (
              <>
                {" "}
                · MRN <span className="font-mono">{patient.fields.mrn}</span>
              </>
            )}{" "}
            · {patient.clinicName}
          </div>
        </CardContent>
      </Card>

      {prescribers.length === 0 ? (
        <Banner tone="warning" title="No active prescriber to write against">
          Transcription needs at least one active provider in the directory. Register the prescriber
          in Providers first.
        </Banner>
      ) : (
        <RxTranscriptionForm
          action={SUBMIT_ACTION}
          patientId={patient.patientId}
          clinicId={patient.clinicId}
          today={today}
          prescribers={prescribers}
          products={catalog.rows}
          scheduleOptions={SCHEDULE_GUIDANCE}
          catalogTruncated={catalog.truncated}
        />
      )}
    </div>
  );
}
