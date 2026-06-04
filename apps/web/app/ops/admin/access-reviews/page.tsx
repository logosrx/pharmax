// /ops/admin/access-reviews — SOC 2 access-review snapshot history.
//
// Lists the most-recent `access_review_snapshot` rows for the
// operator's org (newest first). Each row links through to a detail
// page that renders the full summary + the persisted JSON.
//
// What snapshots ARE (and what this page is NOT):
//   - A snapshot is an immutable, digest-sealed point-in-time
//     freeze of every (user → role → scope → permission) assignment
//     in the org, produced by `RecordAccessReviewSnapshot`.
//   - This page is the **read-only operator surface** over those
//     rows — the same evidence a SOC 2 auditor would inspect, made
//     visible inside the operator console so admins don't have to
//     SSH a database to confirm "did our quarterly review run?".
//   - It does NOT trigger new snapshots. Snapshots are produced by
//     the quarterly CLI (`scripts/security/run-access-review.ts`)
//     or the future scheduled worker, both of which require
//     `compliance.access_review.record` (distinct from `.view`).
//
// Permission gate: `compliance.access_review.view`.
//   - Held by `OrgAdmin` via the `ALL_PERMS` template grant.
//   - A future dedicated `ComplianceOfficer` template will carry
//     this permission without granting `users.manage` or
//     `patients.crypto_shred`, separating "audit reads" from
//     "operational mutations".

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  classifySnapshotHealth,
  listAccessReviewSnapshots,
  type AccessReviewSnapshotHealth,
  type AccessReviewSnapshotListRow,
} from "../../../../src/server/ops/list-access-review-snapshots.js";

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatPeriod(start: Date, end: Date): string {
  return `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`;
}

function truncateDigest(digest: string): string {
  if (digest.length <= 16) return digest;
  return `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

function HealthBadge({ health }: { readonly health: AccessReviewSnapshotHealth }) {
  switch (health) {
    case "clean":
      return (
        <span className="inline-block rounded border border-emerald-700 bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-200">
          CLEAN
        </span>
      );
    case "elevated-only":
      return (
        <span className="inline-block rounded border border-sky-700 bg-sky-950 px-2 py-0.5 text-xs font-medium text-sky-200">
          ELEVATED ONLY
        </span>
      );
    case "attention":
      return (
        <span className="inline-block rounded border border-amber-700 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200">
          ATTENTION
        </span>
      );
    default: {
      const exhaustive: never = health;
      throw new Error(`Unknown health: ${String(exhaustive)}`);
    }
  }
}

export default async function AccessReviewSnapshotsPage() {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Access reviews</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Access reviews</h1>
        <p className="text-rose-300">
          Your role does not include <code>compliance.access_review.view</code>.
        </p>
      </main>
    );
  }

  const rows: ReadonlyArray<AccessReviewSnapshotListRow> = await listAccessReviewSnapshots({
    tenancy: result.tenancy,
    limit: 50,
  });

  return (
    <main className="space-y-6 p-6 text-neutral-100">
      <header>
        <h1 className="text-2xl font-semibold">Access reviews</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Immutable, digest-sealed snapshots of every (user → role → permission) assignment in your
          organization. Produced by the quarterly access-review job and persisted as SOC 2 CC6.2
          evidence; rows are write-once and tamper-evident via canonical-JSON SHA-256.{" "}
          <strong>ATTENTION</strong> rows have at least one stale assignment or inactive principal a
          reviewer should re-justify.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No access-review snapshots have been recorded for this organization yet. The quarterly
          review is run by the security officer via{" "}
          <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
            scripts/security/run-access-review.ts
          </code>{" "}
          or fires automatically once the scheduled worker is configured.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-800">
          <table className="w-full divide-y divide-neutral-800 text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left">Generated</th>
                <th className="px-3 py-2 text-left">Period</th>
                <th className="px-3 py-2 text-right">Principals</th>
                <th className="px-3 py-2 text-right">Elevated</th>
                <th className="px-3 py-2 text-right">Stale</th>
                <th className="px-3 py-2 text-right">Inactive</th>
                <th className="px-3 py-2 text-left">Health</th>
                <th className="px-3 py-2 text-left">Digest</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {rows.map((row) => {
                const health = classifySnapshotHealth(row);
                return (
                  <tr key={row.id} className="hover:bg-neutral-900/60">
                    <td className="px-3 py-2 text-xs text-neutral-300">
                      {formatDate(row.generatedAt)}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-300">
                      {formatPeriod(row.periodStart, row.periodEnd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-neutral-200">
                      {row.totalPrincipals}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
                      {row.elevatedPrincipalCount}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        row.staleAssignmentCount > 0 ? "text-amber-300" : "text-neutral-300"
                      }`}
                    >
                      {row.staleAssignmentCount}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        row.inactivePrincipalCount > 0 ? "text-amber-300" : "text-neutral-300"
                      }`}
                    >
                      {row.inactivePrincipalCount}
                    </td>
                    <td className="px-3 py-2">
                      <HealthBadge health={health} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                      <span title={row.digestSha256}>{truncateDigest(row.digestSha256)}</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/ops/admin/access-reviews/${row.id}`}
                        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
