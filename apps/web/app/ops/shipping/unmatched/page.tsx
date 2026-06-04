// /ops/shipping/unmatched — package-photo triage bucket.
//
// The clerk-facing companion to the dock capture surface
// (`/ops/shipping/dock`). When a dock capture fails to auto-match
// (rep typo on the external order number, capture-before-order,
// packing-station test photo), it lands here with
// `matched = false`. The clerk:
//
//   1. Scans the list of unmatched captures (newest first).
//   2. Clicks "Work this" on a capture → the URL carries
//      `?photoId=<id>`, which expands an inline picker.
//   3. Searches candidate orders by external order number (a
//      barcode scan of the pick-ticket lands in the same input).
//   4. Clicks "Match to this order" on a candidate → a native
//      form POST to the resolve orchestrator, which dispatches
//      `ResolvePackagePhotoMatch` and redirects back here with a
//      typed flash.
//
// Server-rendered, JS-free (consistent with every other ops
// surface). Search is GET-as-form (`?photoId=&q=`); resolve is a
// POST form to `/api/ops/shipping/unmatched/resolve`.
//
// RBAC: gated on `ship.resolve_package_photo_match` — held by
// ShippingClerk, deliberately NOT by PharmacyTechnician. The
// producer (tech captures at the dock) / dispositioner (clerk
// resolves unmatched) separation mirrors the rest of the workflow
// safety model.
//
// PHI rule:
//
//   - Neither the unmatched list nor the order picker decrypts any
//     PHI. The list shows the rep-typed external order number (the
//     pharmacy's own identifier, non-PHI) + structural capture
//     metadata. The picker shows non-PHI order context. The clerk
//     reconciles against the order number printed on the physical
//     package; patient identity is never surfaced here.
//   - The search query (`q`) IS echoed into the URL — acceptable
//     because it's a non-PHI order number, not a patient name.

import Link from "next/link";

import { type OrderPriority, type PackagePhotoTrackingSource } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listUnmatchedPackagePhotos,
  type UnmatchedPackagePhotoRow,
} from "../../../../src/server/ops/list-unmatched-package-photos.js";
import {
  searchOrdersForPhotoMatch,
  type OrderMatchCandidate,
} from "../../../../src/server/ops/search-orders-for-photo-match.js";

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function priorityBadgeClass(priority: OrderPriority): string {
  switch (priority) {
    case "EMERGENCY":
      return "border-red-700 bg-red-950 text-red-200";
    case "RUSH":
      return "border-amber-700 bg-amber-950 text-amber-200";
    case "NORMAL":
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
  }
}

function trackingLabel(source: PackagePhotoTrackingSource | null): string {
  if (source === null) return "no tracking";
  switch (source) {
    case "MANUAL":
      return "manual tracking";
    case "ORDER":
      return "order shipment";
    case "TRACKING_EVENT":
      return "carrier event";
    default: {
      const _exhaust: never = source;
      return _exhaust;
    }
  }
}

const RESOLVE_FLASH: Readonly<Record<string, { readonly title: string; readonly body: string }>> = {
  resolved: {
    title: "Matched",
    body: "The capture is now linked to the order. It has left the unmatched bucket.",
  },
  archived: {
    title: "Archived",
    body: "The capture is dispositioned out of the triage bucket and the order timeline.",
  },
  archived_noop: {
    title: "Already archived",
    body: "This capture was already archived. No change was made.",
  },
};

const ARCHIVE_REASON_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "TEST_CAPTURE", label: "Test capture" },
  { value: "DUPLICATE", label: "Duplicate" },
  { value: "CAPTURED_IN_ERROR", label: "Captured in error" },
  { value: "UNRESOLVABLE", label: "Unresolvable (no order)" },
];

interface UnmatchedRowProps {
  readonly row: UnmatchedPackagePhotoRow;
  readonly nowMs: number;
  readonly isSelected: boolean;
  readonly canArchive: boolean;
}

function UnmatchedRow({ row, nowMs, isSelected, canArchive }: UnmatchedRowProps) {
  const ageMs = nowMs - row.capturedAt.getTime();
  return (
    <li
      className={`space-y-2 rounded-md border p-3 ${
        isSelected ? "border-blue-700 bg-blue-950/30" : "border-neutral-800 bg-neutral-950"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center rounded-md border border-amber-700 bg-amber-950 px-2 py-0.5 text-xs text-amber-200">
            UNMATCHED
          </span>
          <span className="text-neutral-400">typed</span>
          <code className="font-mono text-neutral-100">{row.pharmacyExternalOrderNumber}</code>
          <span className="text-xs text-neutral-500">{formatDuration(ageMs)} ago</span>
        </div>
        {isSelected ? (
          <Link
            href="/ops/shipping/unmatched"
            className="text-xs text-neutral-400 hover:text-neutral-200 hover:underline"
          >
            Close
          </Link>
        ) : (
          <Link
            href={`/ops/shipping/unmatched?photoId=${encodeURIComponent(row.photoId)}`}
            className="rounded-md border border-blue-700 bg-blue-900 px-2.5 py-1 text-xs text-blue-100 hover:bg-blue-800"
          >
            Work this →
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-3">
        {/* Authenticated byte-proxy thumbnail. A plain <img> is
            intentional: this is a per-request-authorized, tenant-scoped
            image — routing it through next/image's public optimizer is
            not appropriate. */}
        <img
          src={`/api/ops/shipping/package-photos/${row.photoId}/image`}
          alt="Sealed package"
          loading="lazy"
          className="h-24 w-auto shrink-0 rounded-md border border-neutral-800 bg-neutral-900 object-contain"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          <span>
            tracking: {trackingLabel(row.trackingSource)}
            {row.trackingNumber !== null ? (
              <>
                {" — "}
                <code className="font-mono text-neutral-300">{row.trackingNumber}</code>
              </>
            ) : null}
          </span>
          <span>
            {row.contentType.replace("image/", "")} · {formatBytes(row.fileSize)}
          </span>
          <span className="font-mono">sha {row.sha256.slice(0, 8)}…</span>
        </div>
      </div>
      {canArchive ? (
        <form
          action="/api/ops/shipping/unmatched/archive"
          method="POST"
          className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-2"
        >
          <input type="hidden" name="photoId" value={row.photoId} />
          <span className="text-xs text-neutral-500">
            Won&apos;t ever match? Archive it out of the bucket:
          </span>
          <select
            name="reason"
            defaultValue="TEST_CAPTURE"
            aria-label="Archive reason"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
          >
            {ARCHIVE_REASON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:border-red-800 hover:bg-red-950 hover:text-red-200"
          >
            Archive
          </button>
        </form>
      ) : null}
    </li>
  );
}

interface CandidateRowProps {
  readonly candidate: OrderMatchCandidate;
  readonly photoId: string;
  readonly nowMs: number;
}

function CandidateRow({ candidate, photoId, nowMs }: CandidateRowProps) {
  const ageMs = nowMs - candidate.receivedAt.getTime();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            href={`/ops/orders/${candidate.orderId}`}
            className="font-mono text-neutral-100 hover:text-blue-300 hover:underline"
          >
            {candidate.externalOrderNumber ?? candidate.orderId}
          </Link>
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${priorityBadgeClass(
              candidate.priority
            )}`}
          >
            {candidate.priority}
          </span>
          <span className="text-xs text-neutral-500">{candidate.currentStatus}</span>
        </div>
        <div className="text-xs text-neutral-500">
          Received {formatDuration(ageMs)} ago
          {candidate.hasShipment ? (
            <span className="text-emerald-400"> · has shipment</span>
          ) : (
            <span className="text-neutral-600"> · no shipment yet</span>
          )}
        </div>
      </div>
      <form action="/api/ops/shipping/unmatched/resolve" method="POST">
        <input type="hidden" name="photoId" value={photoId} />
        <input type="hidden" name="targetOrderId" value={candidate.orderId} />
        <button
          type="submit"
          className="rounded-md border border-emerald-700 bg-emerald-900 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-800"
        >
          Match to this order
        </button>
      </form>
    </li>
  );
}

interface TriagePageSearchParams {
  readonly photoId?: string;
  readonly q?: string;
  readonly flash?: string;
  readonly matchedOrderId?: string;
  readonly error?: string;
}

export default async function UnmatchedTriagePage({
  searchParams,
}: {
  readonly searchParams: Promise<TriagePageSearchParams>;
}) {
  const params = await searchParams;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  const canArchive = hasOperatorPermission(permissions, PERMISSIONS.SHIP_ARCHIVE_PACKAGE_PHOTO);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Unmatched package photos</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to resolve package-photo matches. Contact your admin to
          request the <code className="text-neutral-200">ship.resolve_package_photo_match</code>{" "}
          grant (Shipping Clerk role).
        </p>
      </main>
    );
  }

  const unmatched = await listUnmatchedPackagePhotos({
    organizationId: session.tenancy.organizationId,
  });

  const selectedPhotoId = typeof params.photoId === "string" ? params.photoId : null;
  const selectedPhoto =
    selectedPhotoId !== null
      ? (unmatched.rows.find((r) => r.photoId === selectedPhotoId) ?? null)
      : null;

  const query = typeof params.q === "string" ? params.q : "";
  // Only run the order search when a photo is actively being worked
  // AND the clerk submitted a query — keeps the page a single cheap
  // list render in the common "just browsing the bucket" case.
  const candidates =
    selectedPhoto !== null && query.trim().length > 0
      ? await searchOrdersForPhotoMatch({
          organizationId: session.tenancy.organizationId,
          query,
        })
      : null;

  const flashKey = typeof params.flash === "string" ? params.flash : null;
  const flashBanner = flashKey !== null ? (RESOLVE_FLASH[flashKey] ?? null) : null;
  const flashMatchedOrderId =
    typeof params.matchedOrderId === "string" ? params.matchedOrderId : null;

  const flashError = typeof params.error === "string" ? params.error : null;
  const errorParts = flashError !== null ? splitOnFirstColon(flashError) : null;

  const now = Date.now();

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Unmatched package photos</h1>
        <p className="text-sm text-neutral-400">
          Dock captures that didn&apos;t auto-match. Pick a capture, find the intended order (search
          or scan the order number), and confirm the match. The photo&apos;s capture-time choices
          are preserved — matching only fills the holes.
        </p>
      </header>

      {flashBanner !== null ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          <div className="font-medium">{flashBanner.title}</div>
          <div className="text-xs">{flashBanner.body}</div>
          {flashMatchedOrderId !== null ? (
            <div className="mt-2 text-xs">
              <Link
                href={`/ops/orders/${flashMatchedOrderId}`}
                className="text-emerald-200 underline hover:text-emerald-100"
              >
                Open the matched order →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {errorParts !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          <div className="font-medium">{errorParts.code}</div>
          <div className="text-xs">{errorParts.message}</div>
          {flashMatchedOrderId !== null ? (
            <div className="mt-2 text-xs">
              <Link
                href={`/ops/orders/${flashMatchedOrderId}`}
                className="text-red-100 underline hover:text-red-50"
              >
                See the existing match →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {selectedPhoto !== null ? (
        <section className="space-y-4 rounded-md border border-blue-900 bg-blue-950/20 p-4">
          <header className="space-y-1">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-blue-300">
              Resolve capture
            </h2>
            <p className="text-xs text-neutral-400">
              Rep typed{" "}
              <code className="font-mono text-neutral-200">
                {selectedPhoto.pharmacyExternalOrderNumber}
              </code>{" "}
              — captured {formatDuration(now - selectedPhoto.capturedAt.getTime())} ago. Find the
              order it should have matched.
            </p>
          </header>

          <form method="GET" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="photoId" value={selectedPhoto.photoId} />
            <label className="flex-1 space-y-1 text-xs text-neutral-500">
              Order number (type or scan)
              <input
                type="text"
                name="q"
                defaultValue={query}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="e.g. ORD-2026-001234"
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
              />
            </label>
            <button
              type="submit"
              className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
            >
              Search orders
            </button>
          </form>

          {candidates !== null ? (
            candidates.tooShort ? (
              <div className="text-xs text-neutral-500">
                Type at least 2 characters of the order number to search.
              </div>
            ) : candidates.rows.length === 0 ? (
              <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
                No orders match &ldquo;{query}&rdquo;. Check the number on the package label, or the
                order may not have been entered yet.
              </div>
            ) : (
              <div className="space-y-2">
                {candidates.truncated ? (
                  <div className="text-xs text-amber-300">
                    Showing the first 25 matches — refine the order number to narrow.
                  </div>
                ) : null}
                <ul className="space-y-2">
                  {candidates.rows.map((c) => (
                    <CandidateRow
                      key={c.orderId}
                      candidate={c}
                      photoId={selectedPhoto.photoId}
                      nowMs={now}
                    />
                  ))}
                </ul>
              </div>
            )
          ) : (
            <div className="text-xs text-neutral-500">
              Search for the intended order above to see candidates.
            </div>
          )}
        </section>
      ) : null}

      <section className="space-y-3">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Unmatched bucket
          </h2>
          <span className="text-xs text-neutral-500">
            {unmatched.rows.length}
            {unmatched.truncated ? "+" : ""} waiting
          </span>
        </header>
        {unmatched.truncated ? (
          <div className="rounded-md border border-amber-800 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
            Showing the most recent {unmatched.rows.length} unmatched captures. Work the bucket down
            to see older ones.
          </div>
        ) : null}
        {unmatched.rows.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            Nothing to triage — every dock capture has matched an order. Nice.
          </div>
        ) : (
          <ul className="space-y-2">
            {unmatched.rows.map((row) => (
              <UnmatchedRow
                key={row.photoId}
                row={row}
                nowMs={now}
                isSelected={row.photoId === selectedPhotoId}
                canArchive={canArchive}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function splitOnFirstColon(value: string): { readonly code: string; readonly message: string } {
  const idx = value.indexOf(":");
  if (idx < 0) return { code: "RESOLVE_ERROR", message: value };
  return { code: value.slice(0, idx), message: value.slice(idx + 1) };
}
