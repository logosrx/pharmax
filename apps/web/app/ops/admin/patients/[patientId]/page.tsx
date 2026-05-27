// /ops/admin/patients/[patientId] — patient detail + edit + crypto-shred.
//
// Mirrors the order-detail page's PHI handling: dispatches a
// ViewPatient audit BEFORE rendering the patient block; if the
// audit fails the page refuses to display PHI. Surface is
// `PATIENT_ADMIN_PAGE` (distinct from `ORDER_DETAIL_PAGE` so
// reviewers can slice).
//
// Two forms below the patient block:
//   - Edit identity / contact / address (UpdatePatient) — gated
//     `patients.update`. Pre-filled with the decrypted values so
//     the operator can spot-edit. The command supports partial
//     updates (string sets, null clears, absent leaves alone).
//     Identity (firstName/lastName/DOB) cannot be cleared per
//     the command's Zod schema — use CryptoShredPatient for
//     forget-me.
//   - Crypto-shred (CryptoShredPatient) — gated
//     `patients.crypto_shred` (OrgAdmin by default). Destructive,
//     irreversible. Renders only when the row is NOT already
//     shredded and the operator has the grant.

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

function dash(value: string | null): string {
  return value ?? "—";
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "DECEASED":
    case "MERGED":
      return "border-amber-800 bg-amber-950 text-amber-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
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
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Patient detail</h1>
        <p className="text-neutral-400">You don&apos;t have permission to read patient identity.</p>
      </main>
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
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Patient not found</h1>
        <p>
          <Link href="/ops/admin/patients" className="text-blue-400 hover:underline">
            ← Back to patient search
          </Link>
        </p>
      </main>
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
      <main className="space-y-3">
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          We could not record a PHI-view audit for this page and have refused to display patient
          identity. Operational fault: <code className="font-mono">{audit.code}</code>. Refresh to
          retry.
        </div>
        <p>
          <Link href="/ops/admin/patients" className="text-blue-400 hover:underline">
            ← Back to patient search
          </Link>
        </p>
      </main>
    );
  }

  const flash = typeof sp["flash"] === "string" ? sp["flash"] : null;
  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  const isShredded = detail.cryptoShreddedAt !== null;
  const fullName = [detail.fields.firstName, detail.fields.middleName, detail.fields.lastName]
    .filter((s) => s !== null && s.length > 0)
    .join(" ");

  return (
    <main className="space-y-6">
      <div>
        <Link href="/ops/admin/patients" className="text-sm text-blue-400 hover:underline">
          ← Back to patient search
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-neutral-50">
            {fullName.length === 0 ? "—" : fullName}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 ${statusBadgeClass(
                detail.status
              )}`}
            >
              {detail.status}
            </span>
            <span>
              {detail.clinicName} · {detail.orderCount} order
              {detail.orderCount === 1 ? "" : "s"}
            </span>
            <code className="font-mono">{detail.patientId}</code>
          </div>
        </div>
      </header>

      {flash !== null ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {flash}
        </div>
      ) : null}
      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      {isShredded ? (
        <div className="rounded-md border border-amber-800 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          This patient was crypto-shredded on{" "}
          <span className="font-mono">{formatDate(detail.cryptoShreddedAt!)}</span>. Identity fields
          are permanently unreadable. Edit + re-shred actions are disabled.
        </div>
      ) : null}
      {detail.phiDecryptErrors && !isShredded ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          One or more PHI fields failed to decrypt. Treat as INCOMPLETE; do not edit until the cause
          is investigated.
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Identity
        </h2>
        <dl className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">First name</dt>
            <dd className="text-neutral-100">{dash(detail.fields.firstName)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Middle name</dt>
            <dd className="text-neutral-100">{dash(detail.fields.middleName)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Last name</dt>
            <dd className="text-neutral-100">{dash(detail.fields.lastName)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Date of birth</dt>
            <dd className="text-neutral-100">{dash(detail.fields.dateOfBirth)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Sex at birth</dt>
            <dd className="text-neutral-100">{dash(detail.fields.sexAtBirth)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">SSN last 4</dt>
            <dd className="text-neutral-100">{dash(detail.fields.ssnLast4)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">MRN</dt>
            <dd className="text-neutral-100">{dash(detail.fields.mrn)}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Contact & address
        </h2>
        <dl className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">Phone</dt>
            <dd className="text-neutral-100">{dash(detail.fields.phone)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Email</dt>
            <dd className="text-neutral-100">{dash(detail.fields.email)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Address line 1</dt>
            <dd className="text-neutral-100">{dash(detail.fields.addressLine1)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Address line 2</dt>
            <dd className="text-neutral-100">{dash(detail.fields.addressLine2)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">City</dt>
            <dd className="text-neutral-100">{dash(detail.fields.city)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">State</dt>
            <dd className="text-neutral-100">{dash(detail.fields.state)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Postal code</dt>
            <dd className="text-neutral-100">{dash(detail.fields.postalCode)}</dd>
          </div>
        </dl>
      </section>

      {canUpdate && !isShredded ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Edit patient
          </h2>
          <form
            action={`/api/ops/admin/patients/${detail.patientId}/update`}
            method="POST"
            className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <label className="space-y-1 text-xs text-neutral-500">
              First name
              <input
                type="text"
                name="firstName"
                defaultValue={detail.fields.firstName ?? ""}
                maxLength={100}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Middle name (leave blank → unchanged; clear with the checkbox)
              <input
                type="text"
                name="middleName"
                defaultValue={detail.fields.middleName ?? ""}
                maxLength={100}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Last name
              <input
                type="text"
                name="lastName"
                defaultValue={detail.fields.lastName ?? ""}
                maxLength={100}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Date of birth (YYYY-MM-DD)
              <input
                type="text"
                name="dateOfBirth"
                defaultValue={detail.fields.dateOfBirth ?? ""}
                placeholder="1985-03-14"
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Phone
              <input
                type="text"
                name="phone"
                defaultValue={detail.fields.phone ?? ""}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Email
              <input
                type="email"
                name="email"
                defaultValue={detail.fields.email ?? ""}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
              Address line 1
              <input
                type="text"
                name="addressLine1"
                defaultValue={detail.fields.addressLine1 ?? ""}
                maxLength={200}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Address line 2
              <input
                type="text"
                name="addressLine2"
                defaultValue={detail.fields.addressLine2 ?? ""}
                maxLength={200}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              City
              <input
                type="text"
                name="city"
                defaultValue={detail.fields.city ?? ""}
                maxLength={100}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              State (2-letter code)
              <input
                type="text"
                name="state"
                defaultValue={detail.fields.state ?? ""}
                maxLength={2}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm uppercase text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Postal code
              <input
                type="text"
                name="postalCode"
                defaultValue={detail.fields.postalCode ?? ""}
                maxLength={10}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              MRN
              <input
                type="text"
                name="mrn"
                defaultValue={detail.fields.mrn ?? ""}
                maxLength={64}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-3">
              <p className="mb-2 text-xs text-neutral-500">
                Submitting saves ALL non-empty fields above. Empty optional fields are LEFT
                UNCHANGED (use crypto-shred for forget-me). The command redacts every field from{" "}
                <code>command_log.requestPayload</code> before persist.
              </p>
              <button
                type="submit"
                className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
              >
                Save changes
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {canCryptoShred && !isShredded ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-red-400">
            Crypto-shred
          </h2>
          <div className="rounded-md border border-red-800 bg-red-950 p-4 text-sm text-red-200">
            <p className="mb-2">
              <strong>Destructive + irreversible.</strong> Renders every PHI envelope and
              blind-index column NULL; the underlying DEK is destroyed. Order references stay intact
              (FK integrity), but no future read can recover the original identity.
            </p>
            <form
              action={`/api/ops/admin/patients/${detail.patientId}/crypto-shred`}
              method="POST"
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
            >
              <label className="space-y-1 text-xs text-red-300 sm:col-span-2">
                Reason
                <select
                  name="reason"
                  defaultValue={CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN}
                  className="block w-full rounded-md border border-red-700 bg-red-950 px-2 py-1.5 text-sm text-red-100"
                >
                  {Object.values(CRYPTO_SHRED_REASONS).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <div className="self-end">
                <button
                  type="submit"
                  className="rounded-md border border-red-700 bg-red-900 px-3 py-1.5 text-sm text-red-100 hover:bg-red-800"
                >
                  Crypto-shred this patient
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}
    </main>
  );
}
