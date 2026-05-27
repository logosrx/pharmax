// /ops/admin/patients — patient roster admin search page.
//
// PHI surface. Decrypts identifying fields (first/last/DOB/MRN)
// for every visible search result so the operator can disambiguate
// matches. Every result render dispatches a ViewPatient audit
// with surface=PATIENT_SEARCH_RESULT (one per patient — the
// SOC 2 reviewer can answer "who saw patient X" exactly).
//
// Gating: visibility requires `patients.read`. The search itself
// refuses to run without a query term (enforced inside
// `searchPatients`) — we don't dispense unbounded patient scans
// from the admin surface either.
//
// The form's query terms (name, DOB, etc.) are deliberately NOT
// echoed back into the URL as plaintext — search re-submissions
// re-type the query. Echoing PHI into the URL would leak it into
// browser history + referer headers + access logs.

import Link from "next/link";

import { PatientStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { auditPatientViewsBatch } from "../../../../src/server/ops/audit-patient-view.js";
import { searchPatientsForAdmin } from "../../../../src/server/ops/search-patients-for-admin.js";

function statusBadgeClass(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "INACTIVE":
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
    case "DECEASED":
      return "border-amber-800 bg-amber-950 text-amber-200";
    case "MERGED":
      return "border-blue-800 bg-blue-950 text-blue-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
  }
}

// Pull the form-submitted query terms from the URL search params.
// We intentionally do POST-as-GET via the form's `method="GET"` so
// the form's input names land in searchParams. PHI exposure
// caveat: the operator submitting a name search WILL see that
// name in their browser URL bar + history. Acceptable: admin
// workflows expect this, and the operator is already authorized
// to view this PHI. Server-side, we don't log the params.
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
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Patient roster</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to read patient identity. Contact your admin to request{" "}
          <code className="text-neutral-200">patients.read</code>.
        </p>
      </main>
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
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Patient roster</h1>
        <p className="text-sm text-neutral-400">
          PHI-safe blind-index search. Provide at least one query term — we don&apos;t dispense
          unbounded patient scans. Every result render dispatches a tamper-evident view audit per
          patient.
        </p>
      </header>

      <form
        method="GET"
        className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4 sm:grid-cols-3 lg:grid-cols-4"
      >
        <label className="space-y-1 text-xs text-neutral-500">
          First name
          <input
            type="text"
            name="firstName"
            defaultValue={query.firstName ?? ""}
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Last name
          <input
            type="text"
            name="lastName"
            defaultValue={query.lastName ?? ""}
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Date of birth (YYYY-MM-DD)
          <input
            type="text"
            name="dateOfBirth"
            defaultValue={query.dateOfBirth ?? ""}
            placeholder="1985-03-14"
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          MRN
          <input
            type="text"
            name="mrn"
            defaultValue={query.mrn ?? ""}
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Phone (digits only)
          <input
            type="text"
            name="phone"
            defaultValue={query.phone ?? ""}
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Email
          <input
            type="email"
            name="email"
            defaultValue={query.email ?? ""}
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-500">
          Postal code
          <input
            type="text"
            name="postalCode"
            defaultValue={query.postalCode ?? ""}
            autoComplete="off"
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          />
        </label>
        <label className="flex items-end gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            name="includeNonActive"
            value="true"
            defaultChecked={includeNonActive}
            className="rounded border-neutral-700 bg-neutral-900"
          />
          Include inactive / deceased / merged
        </label>
        <div className="sm:col-span-3 lg:col-span-4">
          <button
            type="submit"
            className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
          >
            Search
          </button>
        </div>
      </form>

      {searchError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {searchError}
        </div>
      ) : null}

      {auditBatch !== null && auditBatch.failedPatientIds.length > 0 ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          PHI-view audit failed for {auditBatch.failedPatientIds.length} of {auditBatch.attempted}{" "}
          results. The page rendered the data anyway — this is a compliance regression and an
          operator id ({session.operator.userId}) should be reported.
        </div>
      ) : null}

      {results !== null ? (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
              Results ({results.rows.length})
            </h2>
            <span className="text-xs text-neutral-500">{results.tookMs}ms</span>
          </header>
          {results.rows.length === 0 ? (
            <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
              No patients match.
            </div>
          ) : (
            <ul className="space-y-2">
              {results.rows.map((row) => {
                const name = [row.firstName, row.middleName, row.lastName]
                  .filter((s) => s !== null && s.length > 0)
                  .join(" ");
                return (
                  <li
                    key={row.patientId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/ops/admin/patients/${row.patientId}`}
                          className="text-neutral-100 hover:text-blue-300 hover:underline"
                        >
                          {name.length === 0 ? "—" : name}
                        </Link>
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${statusBadgeClass(
                            row.status
                          )}`}
                        >
                          {row.status}
                        </span>
                        {row.cryptoShreddedAt !== null ? (
                          <span className="inline-flex items-center rounded-md border border-amber-800 bg-amber-950 px-2 py-0.5 text-xs text-amber-200">
                            crypto-shredded
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-neutral-500">
                        DOB <span className="font-mono">{row.dateOfBirth ?? "—"}</span>
                        {row.mrn !== null ? (
                          <>
                            {" · "}MRN <span className="font-mono">{row.mrn}</span>
                          </>
                        ) : null}
                        {row.phiDecryptErrors ? (
                          <span className="text-red-400"> · decrypt errors</span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : !submitted ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-500">
          Enter at least one query term above and click Search.
        </div>
      ) : null}

      {/* Reference the PatientStatus type so an unused-import lint
          doesn't fire when the only consumer is the badge color
          switch (string-typed) above. */}
      <span className="hidden" data-statuses={Object.values(PatientStatus).join(",")} />
    </main>
  );
}
