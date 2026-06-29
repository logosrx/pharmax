// /ops/admin/patients — patient roster admin search page.
//
// PHI surface. Decrypts identifying fields for each visible result so
// the operator can disambiguate matches; every result render
// dispatches a ViewPatient audit (surface=PATIENT_SEARCH_RESULT). The
// blind-index search refuses to run without a query term. Query terms
// are NOT echoed server-side (logs); they do appear in the operator's
// URL (acceptable — the operator is authorized to view this PHI).

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { auditPatientViewsBatch } from "../../../../src/server/ops/audit-patient-view.js";
import { searchPatientsForAdmin } from "../../../../src/server/ops/search-patients-for-admin.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, LinkCard } from "../../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, inputClass } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

function statusTone(status: string): Tone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DECEASED":
      return "warning";
    case "MERGED":
      return "info";
    default:
      return "neutral";
  }
}

function pluck(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v.trim();
}

export default async function PatientAdminSearchPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Patient roster" />
        <PermissionDenied grant="patients.read" />
      </div>
    );
  }

  const query = {
    firstName: pluck(params, "firstName"),
    lastName: pluck(params, "lastName"),
    dateOfBirth: pluck(params, "dateOfBirth"),
    dateOfBirthYearMonth: pluck(params, "dateOfBirthYearMonth"),
    mrn: pluck(params, "mrn"),
    phone: pluck(params, "phone"),
    email: pluck(params, "email"),
    postalCode: pluck(params, "postalCode"),
  };
  const includeNonActive = params["includeNonActive"] === "true";
  const submitted = Object.values(query).some((v) => v !== undefined);

  let results: Awaited<ReturnType<typeof searchPatientsForAdmin>> | null = null;
  let searchError: string | null = null;
  let auditBatch: Awaited<ReturnType<typeof auditPatientViewsBatch>> | null = null;
  if (submitted) {
    try {
      results = await searchPatientsForAdmin({
        organizationId: session.tenancy.organizationId,
        query,
        includeNonActive,
      });
      auditBatch = await auditPatientViewsBatch({
        organizationId: session.tenancy.organizationId,
        operatorUserId: session.operator.userId,
        surface: "PATIENT_SEARCH_RESULT",
        patients: results.rows.map((r) => ({
          patientId: r.patientId,
          phiDecryptErrors: r.phiDecryptErrors,
        })),
      });
    } catch (cause) {
      searchError = cause instanceof Error ? cause.message : "Patient search failed unexpectedly.";
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Patient roster"
        description="PHI-safe blind-index search. Provide at least one query term — we don't dispense unbounded patient scans. Every result render dispatches a tamper-evident view audit per patient."
      />

      <Card>
        <CardContent>
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4" method="GET">
            <Field label="First name">
              <input
                type="text"
                name="firstName"
                defaultValue={query.firstName ?? ""}
                autoComplete="off"
                className={inputClass()}
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                name="lastName"
                defaultValue={query.lastName ?? ""}
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
            <Field label="Phone">
              <input
                type="text"
                name="phone"
                defaultValue={query.phone ?? ""}
                autoComplete="off"
                className={inputClass("font-mono")}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                name="email"
                defaultValue={query.email ?? ""}
                autoComplete="off"
                className={inputClass()}
              />
            </Field>
            <Field label="Postal code">
              <input
                type="text"
                name="postalCode"
                defaultValue={query.postalCode ?? ""}
                autoComplete="off"
                className={inputClass("font-mono")}
              />
            </Field>
            <label className="flex items-end gap-2 pb-1.5 text-xs text-muted">
              <input
                type="checkbox"
                name="includeNonActive"
                value="true"
                defaultChecked={includeNonActive}
                className="accent-brand"
              />
              Include inactive / deceased / merged
            </label>
            <div className="sm:col-span-3 lg:col-span-4">
              <button type="submit" className={buttonClass({ variant: "primary" })}>
                <Icon name="search" size={16} />
                Search
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      {searchError !== null ? (
        <Banner tone="danger" title="Search failed">
          {searchError}
        </Banner>
      ) : null}

      {auditBatch !== null && auditBatch.failedPatientIds.length > 0 ? (
        <Banner tone="danger" title="PHI-view audit incomplete">
          Audit failed for {auditBatch.failedPatientIds.length} of {auditBatch.attempted} results.
          The page rendered the data anyway — this is a compliance regression; report operator id{" "}
          <code>{session.operator.userId}</code>.
        </Banner>
      ) : null}

      {results !== null ? (
        <Section title="Results" count={results.rows.length} aside={`${results.tookMs}ms`}>
          {results.rows.length === 0 ? (
            <EmptyState icon="patients" title="No patients match" />
          ) : (
            <div className="space-y-2">
              {results.rows.map((row) => {
                const name = [row.firstName, row.middleName, row.lastName]
                  .filter((s) => s !== null && s.length > 0)
                  .join(" ");
                return (
                  <LinkCard key={row.patientId} href={`/ops/admin/patients/${row.patientId}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-fg">
                        {name.length === 0 ? "—" : name}
                      </span>
                      <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                      {row.cryptoShreddedAt !== null ? (
                        <Badge tone="warning">crypto-shredded</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-subtle">
                      DOB <span className="font-mono">{row.dateOfBirth ?? "—"}</span>
                      {row.mrn !== null ? (
                        <>
                          {" "}
                          · MRN <span className="font-mono">{row.mrn}</span>
                        </>
                      ) : null}
                      {row.phiDecryptErrors ? (
                        <span className="text-red-400"> · decrypt errors</span>
                      ) : null}
                    </div>
                  </LinkCard>
                );
              })}
            </div>
          )}
        </Section>
      ) : !submitted ? (
        <EmptyState
          icon="search"
          title="Search the patient roster"
          description="Enter at least one query term above and search."
        />
      ) : null}
    </div>
  );
}
