// /ops/orders/[orderId] — operator order-detail page.
//
// PHI surface: this page DECRYPTS patient identity, contact, and
// prescription `sig`. Gated on `orders.read` AND `patients.read`.
// Every render that displays PHI dispatches `ViewPatient` BEFORE
// rendering, which writes a tamper-evident chain-hashed audit row
// in `audit_log` + emits `patient.viewed.v1` to the outbox. If
// the audit write fails, the page refuses to render the patient
// block (we fail closed on the "every PHI display has an audit
// row" invariant).
//
// What this page does NOT do (yet):
//   - In-page workflow actions. PV1 approve/reject already lives
//     on `/ops/pv1`; we link back there. The detail view is for
//     READING — workflow mutation stays on the queue surface.
//   - Show the scan / print history. Future enhancement.
//
// PHI rendering rule:
//   - Use `<dd>...</dd>` for every decrypted value so screen
//     scrapers can't accidentally pluck a raw plaintext from a
//     prop or data-attribute. Render `"—"` for null fields.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { auditPatientView } from "../../../../src/server/ops/audit-patient-view.js";
import { getOrderDetail } from "../../../../src/server/ops/get-order-detail.js";

function dash(value: string | null): string {
  return value ?? "—";
}

function formatDate(value: Date | null): string {
  if (value === null) return "—";
  return value.toISOString().slice(0, 10);
}

function formatDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

// Match-strategy badge text. Mirrors the dock + triage surfaces so
// an operator sees the same vocabulary everywhere a capture appears.
function matchStrategyLabel(strategy: string): string {
  switch (strategy) {
    case "EXTERNAL_ORDER_NUMBER":
      return "AUTO-MATCHED";
    case "MANUAL_ORDER_ID":
      return "RESOLVED · ORDER";
    case "MANUAL_PATIENT_ID":
      return "RESOLVED · PATIENT";
    case "UNMATCHED":
      // Shouldn't appear on this relation (it's the matched-order
      // back-relation), but render defensively rather than crash.
      return "UNMATCHED";
    default:
      return strategy;
  }
}

function matchStrategyBadgeClass(strategy: string): string {
  switch (strategy) {
    case "MANUAL_ORDER_ID":
    case "MANUAL_PATIENT_ID":
      return "border-blue-700 bg-blue-950 text-blue-200";
    case "EXTERNAL_ORDER_NUMBER":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
  }
}

function trackingSourceLabel(source: string | null): string {
  if (source === null) return "no tracking";
  switch (source) {
    case "MANUAL":
      return "manual tracking";
    case "ORDER":
      return "order shipment";
    case "TRACKING_EVENT":
      return "carrier event";
    default:
      return source;
  }
}

function formatAddress(p: {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}): string {
  const parts: string[] = [];
  if (p.addressLine1 !== null) parts.push(p.addressLine1);
  if (p.addressLine2 !== null) parts.push(p.addressLine2);
  const cityStateZip = [p.city, p.state, p.postalCode].filter((s) => s !== null).join(" ");
  if (cityStateZip.length > 0) parts.push(cityStateZip);
  return parts.length === 0 ? "—" : parts.join(", ");
}

export default async function OrderDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORDERS_READ)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Order detail</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to view orders. Contact your admin to request the{" "}
          <code className="text-neutral-200">orders.read</code> grant.
        </p>
      </main>
    );
  }
  if (!hasOperatorPermission(permissions, PERMISSIONS.PATIENTS_READ)) {
    // Order detail is a PHI-decrypting surface; without
    // `patients.read` the operator cannot legitimately read the
    // patient block. We refuse the whole page rather than render a
    // half-populated view — the order metadata alone (drug name,
    // qty) isn't useful for the surfaces this page serves.
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Order detail</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to read patient identity. Contact your admin to request the{" "}
          <code className="text-neutral-200">patients.read</code> grant.
        </p>
      </main>
    );
  }

  const detail = await getOrderDetail({
    organizationId: session.tenancy.organizationId,
    orderId,
  });

  if (detail === null) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Order not found</h1>
        <p className="text-neutral-400">
          This order doesn&apos;t exist in your organization.{" "}
          <Link href="/ops/pv1" className="text-blue-400 hover:underline">
            Back to PV1
          </Link>
        </p>
      </main>
    );
  }

  // Tamper-evident PHI-view audit. Writes a chain-hashed row to
  // `audit_log` + emits `patient.viewed.v1`. If this fails, we
  // refuse to render the patient block: "every PHI display has an
  // audit row" is a load-bearing invariant.
  const audit = await auditPatientView({
    organizationId: session.tenancy.organizationId,
    operatorUserId: session.operator.userId,
    patientId: detail.patient.patientId,
    surface: "ORDER_DETAIL_PAGE",
    orderId: detail.orderId,
    phiDecryptErrors: detail.phiDecryptErrors,
  });
  if (!audit.ok) {
    return (
      <main className="space-y-3">
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          We could not record a PHI-view audit for this page render and have refused to display
          patient identity. Operational fault: <code className="font-mono">{audit.code}</code>.
          Refresh to retry, or contact your admin if this persists.
        </div>
        <p className="text-neutral-400">
          <Link href="/ops/pv1" className="text-blue-400 hover:underline">
            Back to PV1
          </Link>
        </p>
      </main>
    );
  }

  const patientName =
    detail.patient.firstName !== null || detail.patient.lastName !== null
      ? [detail.patient.firstName, detail.patient.middleName, detail.patient.lastName]
          .filter((s) => s !== null && s.length > 0)
          .join(" ")
      : "—";

  return (
    <main className="space-y-6">
      <div>
        <Link href="/ops/pv1" className="text-sm text-blue-400 hover:underline">
          ← Back to PV1 queue
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-mono text-2xl font-semibold text-neutral-50">
            {detail.externalOrderNumber ?? detail.orderId}
          </h1>
          <div className="text-xs text-neutral-500">
            Order id <code className="text-neutral-300">{detail.orderId}</code>
          </div>
        </div>
        <div className="space-y-1 text-right text-xs">
          <div>
            <span className="text-neutral-500">Status</span>{" "}
            <span className="text-neutral-200">{detail.currentStatus}</span>
          </div>
          <div>
            <span className="text-neutral-500">Priority</span>{" "}
            <span className="text-neutral-200">{detail.priority}</span>
          </div>
        </div>
      </header>

      {audit.output.wasShredded ? (
        <div className="rounded-md border border-amber-800 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          This patient was CRYPTO-SHREDDED (right-to-be-forgotten). Identity fields below are
          permanently unreadable — order metadata is preserved for audit history only. Your access
          attempt is recorded.
        </div>
      ) : null}

      {detail.phiDecryptErrors ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          One or more PHI fields failed to decrypt. Treat the patient view as INCOMPLETE; do not
          make clinical decisions on this record until the cause is investigated (KMS misconfig,
          envelope corruption, or stale data). Operator user id:{" "}
          <code className="font-mono">{session.operator.userId}</code>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Patient</h2>
        <dl className="grid grid-cols-1 gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">Name</dt>
            <dd className="text-neutral-100">{patientName}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Date of birth</dt>
            <dd className="text-neutral-100">{dash(detail.patient.dateOfBirth)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Phone</dt>
            <dd className="text-neutral-100">{dash(detail.patient.phone)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Email</dt>
            <dd className="text-neutral-100">{dash(detail.patient.email)}</dd>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-xs text-neutral-500">Address</dt>
            <dd className="text-neutral-100">{formatAddress(detail.patient)}</dd>
          </div>
        </dl>
        <div className="text-xs text-neutral-600">
          Patient id <code className="text-neutral-500">{detail.patient.patientId}</code>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Prescription lines
        </h2>
        {detail.lines.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
            No lines on this order.
          </div>
        ) : (
          <ul className="space-y-3">
            {detail.lines.map((line, idx) => (
              <li
                key={line.orderLineId}
                className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4"
              >
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-xs text-neutral-500">Line {idx + 1}</div>
                    <div className="text-base text-neutral-100">
                      {line.drugName}
                      {line.drugStrength !== null ? ` ${line.drugStrength}` : ""}
                      {line.drugForm !== null ? ` (${line.drugForm})` : ""}
                    </div>
                    <div className="font-mono text-xs text-neutral-500">
                      Rx {line.rxNumber} · NDC {line.drugNdc}
                    </div>
                  </div>
                  <div className="text-right text-xs text-neutral-400">
                    <div>
                      Qty <span className="text-neutral-100">{line.quantityToFill}</span>
                    </div>
                    <div>
                      {line.daysSupplyToFill} day supply · {line.refillsRemaining} refills left
                    </div>
                  </div>
                </header>

                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-neutral-500">Sig (directions)</dt>
                    <dd className="text-neutral-100">{dash(line.sig)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Prescriber</dt>
                    <dd className="text-neutral-100">
                      {line.prescriberName} ·{" "}
                      <span className="font-mono text-xs text-neutral-400">
                        NPI {line.prescriberNpi}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Lot</dt>
                    <dd className="text-neutral-100">
                      {line.assignedLotNumber !== null
                        ? `${line.assignedLotNumber} (exp ${formatDate(line.assignedLotExpiry)})`
                        : "Not yet assigned"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Vial label</dt>
                    <dd className="text-neutral-100">
                      {line.vialLabelId !== null ? (
                        <code className="font-mono text-xs">{line.vialLabelId}</code>
                      ) : (
                        "Not yet printed"
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Package photos
        </h2>
        {detail.packagePhotos.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
            No sealed-package photos linked to this order yet. Captures taken at the dock and
            matched to this order appear here.
          </div>
        ) : (
          <ul className="space-y-2">
            {detail.packagePhotos.map((photo) => (
              <li
                key={photo.photoId}
                className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-3"
              >
                {/* Authenticated byte-proxy. A plain <img> is intentional:
                    next/image would route this private,
                    per-request-authorized image through the public image
                    optimizer, which we explicitly do not want for
                    tenant-scoped photo bytes. */}
                <img
                  src={`/api/ops/shipping/package-photos/${photo.photoId}/image`}
                  alt="Sealed package"
                  loading="lazy"
                  className="max-h-56 w-auto rounded-md border border-neutral-800 bg-neutral-900 object-contain"
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${matchStrategyBadgeClass(
                      photo.matchStrategy
                    )}`}
                  >
                    {matchStrategyLabel(photo.matchStrategy)}
                  </span>
                  <span className="text-xs text-neutral-500">
                    Captured {formatDateTime(photo.capturedAt)}
                  </span>
                  {photo.matchedAt !== null ? (
                    <span className="text-xs text-neutral-600">
                      · matched {formatDateTime(photo.matchedAt)}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                  <span>
                    tracking: {trackingSourceLabel(photo.trackingSource)}
                    {photo.trackingNumber !== null ? (
                      <>
                        {" — "}
                        <code className="font-mono text-neutral-300">{photo.trackingNumber}</code>
                      </>
                    ) : null}
                  </span>
                  <span>
                    {photo.contentType.replace("image/", "")} · {formatBytes(photo.fileSize)}
                  </span>
                  <span className="font-mono">sha {photo.sha256.slice(0, 8)}…</span>
                  <span>
                    captured by <code className="text-neutral-400">{photo.capturedByUserId}</code>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Recent events
        </h2>
        {detail.events.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
            No events recorded yet.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950">
            {detail.events.map((evt) => (
              <li
                key={evt.orderEventId}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <div className="space-y-0.5">
                  <div className="font-mono text-neutral-200">{evt.eventType}</div>
                  <div className="text-xs text-neutral-500">
                    seq {evt.sequenceNumber}
                    {evt.actorUserId !== null ? (
                      <>
                        {" · "}actor <code className="text-neutral-400">{evt.actorUserId}</code>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="font-mono text-xs text-neutral-400">
                  {formatDateTime(evt.occurredAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
