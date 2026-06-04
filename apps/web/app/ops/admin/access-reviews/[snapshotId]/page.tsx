// /ops/admin/access-reviews/[snapshotId] — snapshot detail.
//
// Single-row view of an `access_review_snapshot`. Renders:
//   1. Provenance header — generated-at, period, organization slug
//      (as-of generation time), recorded-by operator identity,
//      command-log id (the audit-chain anchor), and the
//      canonical-JSON SHA-256 digest. The digest is the
//      tamper-evidence claim: the JSON evidence file in the
//      separate evidence repo must hash to this value.
//   2. Summary scalars — total / elevated / inactive / stale /
//      crypto-shred-capable counts, the five fields a SOC 2
//      reviewer asks for at a glance.
//   3. Persisted report (JSONB) — the full
//      `AccessReviewReport` payload in a `<pre>` block so the
//      operator can scroll the per-principal breakdown without
//      leaving the console.
//
// PHI: none. The persisted report contains operator identity
// (email, displayName) but never patient data — invariant
// enforced upstream in `generateAccessReview` and codified on
// `RecordAccessReviewSnapshot`.
//
// Permission gate: `compliance.access_review.view` (same as the
// list page).

import Link from "next/link";
import { notFound } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { getAccessReviewSnapshotById } from "../../../../../src/server/ops/list-access-review-snapshots.js";

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface PageProps {
  readonly params: Promise<{ readonly snapshotId: string }>;
}

export default async function AccessReviewSnapshotDetailPage({ params }: PageProps) {
  const { snapshotId } = await params;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Access review snapshot</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Access review snapshot</h1>
        <p className="text-rose-300">
          Your role does not include <code>compliance.access_review.view</code>.
        </p>
      </main>
    );
  }

  const detail = await getAccessReviewSnapshotById({
    tenancy: result.tenancy,
    snapshotId,
  });
  if (detail === null) {
    notFound();
  }

  // Pretty-print the JSON payload. Inline JSON.stringify keeps the
  // server work simple; the typical report is ~10-50 KB and renders
  // fine without virtualization.
  const reportJson = JSON.stringify(detail.report, null, 2);

  return (
    <main className="space-y-6 p-6 text-neutral-100">
      <header className="space-y-1">
        <Link
          href="/ops/admin/access-reviews"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← Back to access reviews
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Access review snapshot</h1>
        <p className="text-sm text-neutral-400">
          Generated {formatDate(detail.generatedAt)} · period {formatDateOnly(detail.periodStart)} →{" "}
          {formatDateOnly(detail.periodEnd)} · org slug{" "}
          <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
            {detail.organizationSlug}
          </code>
        </p>
      </header>

      <section className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
          Provenance
        </h2>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Field label="Snapshot id">
            <code className="break-all rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
              {detail.id}
            </code>
          </Field>
          <Field label="Report version">v{detail.reportVersion}</Field>
          <Field label="Digest (SHA-256, canonical JSON)">
            <code className="break-all rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-xs">
              {detail.digestSha256}
            </code>
          </Field>
          <Field label="Command log id">
            <code className="break-all rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
              {detail.commandLogId}
            </code>
          </Field>
          <Field label="Recorded by">
            {detail.recorder === null ? (
              <span className="text-neutral-500">
                — (system-tier job; no human operator on the record)
              </span>
            ) : (
              <span>
                {detail.recorder.displayName ?? "(no display name)"}
                {detail.recorder.email !== null ? (
                  <span className="text-neutral-500"> &lt;{detail.recorder.email}&gt;</span>
                ) : null}
              </span>
            )}
          </Field>
          <Field label="Persisted at">{formatDate(detail.createdAt)}</Field>
        </dl>
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
          Summary
        </h2>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
          <Metric label="Total principals" value={detail.totalPrincipals} />
          <Metric
            label="Elevated"
            value={detail.elevatedPrincipalCount}
            warn={detail.elevatedPrincipalCount > 0 ? "sky" : null}
          />
          <Metric
            label="Inactive"
            value={detail.inactivePrincipalCount}
            warn={detail.inactivePrincipalCount > 0 ? "amber" : null}
          />
          <Metric
            label="Stale assignments"
            value={detail.staleAssignmentCount}
            warn={detail.staleAssignmentCount > 0 ? "amber" : null}
          />
          <Metric
            label="Crypto-shred roles"
            value={detail.cryptoShredCapableRoleCount}
            warn={detail.cryptoShredCapableRoleCount > 0 ? "sky" : null}
          />
        </dl>
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
          Persisted report (JSON)
        </h2>
        <p className="mb-3 text-xs text-neutral-500">
          The full <code>AccessReviewReport</code> payload as stored on the row, frozen at write
          time. Recompute the SHA-256 of the canonical (sorted-key) serialization to verify against
          the digest above.
        </p>
        <pre className="max-h-[60vh] overflow-auto rounded bg-neutral-900 p-3 text-xs leading-relaxed text-neutral-200">
          {reportJson}
        </pre>
      </section>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{children}</dd>
    </div>
  );
}

function Metric({
  label,
  value,
  warn,
}: {
  readonly label: string;
  readonly value: number;
  readonly warn?: "amber" | "sky" | null;
}) {
  const valueClass =
    warn === "amber" ? "text-amber-300" : warn === "sky" ? "text-sky-300" : "text-neutral-100";
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</dd>
    </div>
  );
}
