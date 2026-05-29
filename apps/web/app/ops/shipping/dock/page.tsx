// /ops/shipping/dock — pre-shipment package-photo capture surface.
//
// The shipping rep stands at the dock with a phone or tablet,
// snaps a photo of each sealed package, and types the pharmacy's
// external order number off the printed pick-ticket. This page
// renders:
//
//   - A multipart form with the native camera capture input
//     (`<input type="file" accept="image/*" capture="environment">`)
//     plus the external-order-number field and optional manual
//     tracking + notes fields. The form posts to
//     `POST /api/ops/shipping/package-photos/capture`, which
//     orchestrates `beginUpload` + `CapturePackagePhoto` in a
//     single round-trip and redirects back here with a typed
//     flash query param so the operator sees the result inline.
//
//   - The operator's last 10 captures, surfaced via
//     `listRecentPackagePhotoCaptures`. Each row shows match
//     status (matched / unmatched / duplicate-from-server-flash)
//     so the rep can verify "did my last snap actually land".
//
// PHI rule:
//
//   - The page never decrypts `notesEnc`; recent captures show
//     only structural metadata (external order number, match
//     state, tracking source, sha256). Order detail (the only
//     PHI-decrypting view) is one click away via the matched
//     order's deep-link.
//   - The flash query string never carries patient identifiers,
//     external order numbers, or notes. Only opaque ids
//     (photoId, matchedOrderId).
//
// RBAC:
//
//   - Gate is `ship.capture_package_photo`. Same permission the
//     orchestrator route enforces — duplicating it here keeps the
//     "no permission" message in front of the operator before they
//     waste effort populating the form.

import Link from "next/link";

import { type PackagePhotoMatchStrategy, type PackagePhotoTrackingSource } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listRecentPackagePhotoCaptures,
  type RecentPackagePhotoCapture,
} from "../../../../src/server/ops/list-recent-package-photo-captures.js";

const DOCK_FLASH_BANNERS: Readonly<
  Record<string, { readonly tone: "ok" | "warn"; readonly title: string; readonly body: string }>
> = {
  matched: {
    tone: "ok",
    title: "Captured and matched",
    body: "Photo saved and linked to the matching order. You can keep packing.",
  },
  unmatched: {
    tone: "warn",
    title: "Captured but not matched",
    body: "We saved the photo but couldn't find an order for that external number. A clerk will triage it from the unmatched bucket — verify the order number on the next package.",
  },
  duplicate: {
    tone: "ok",
    title: "Already captured",
    body: "We already have this exact photo on file. Nothing to do — the existing capture stays linked to its original order.",
  },
};

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

function matchBadgeClass(matched: boolean, strategy: PackagePhotoMatchStrategy): string {
  if (!matched) {
    return "border-amber-700 bg-amber-950 text-amber-200";
  }
  if (strategy === "MANUAL_PATIENT_ID" || strategy === "MANUAL_ORDER_ID") {
    return "border-blue-700 bg-blue-950 text-blue-200";
  }
  return "border-emerald-700 bg-emerald-950 text-emerald-200";
}

function matchBadgeLabel(matched: boolean, strategy: PackagePhotoMatchStrategy): string {
  if (!matched) return "UNMATCHED";
  switch (strategy) {
    case "EXTERNAL_ORDER_NUMBER":
      return "AUTO-MATCHED";
    case "MANUAL_ORDER_ID":
      return "RESOLVED · ORDER";
    case "MANUAL_PATIENT_ID":
      return "RESOLVED · PATIENT";
    case "UNMATCHED":
      return "UNMATCHED";
    default: {
      // Exhaustive — TypeScript keeps this honest.
      const _exhaust: never = strategy;
      return _exhaust;
    }
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

interface CaptureRowProps {
  readonly row: RecentPackagePhotoCapture;
  readonly nowMs: number;
}

function CaptureRow({ row, nowMs }: CaptureRowProps) {
  const ageMs = nowMs - row.capturedAt.getTime();
  return (
    <li className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${matchBadgeClass(
            row.matched,
            row.matchStrategy
          )}`}
        >
          {matchBadgeLabel(row.matched, row.matchStrategy)}
        </span>
        <code className="font-mono text-neutral-100">{row.pharmacyExternalOrderNumber}</code>
        <span className="text-xs text-neutral-500">{formatDuration(ageMs)} ago</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        {row.matched && row.matchedOrderId !== null ? (
          <Link
            href={`/ops/orders/${row.matchedOrderId}`}
            className="text-blue-300 hover:underline"
          >
            View order →
          </Link>
        ) : null}
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
    </li>
  );
}

interface DockPageSearchParams {
  readonly flash?: string;
  readonly photoId?: string;
  readonly matchedOrderId?: string;
  readonly error?: string;
}

export default async function DockCapturePage({
  searchParams,
}: {
  readonly searchParams: Promise<DockPageSearchParams>;
}) {
  const params = await searchParams;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Dock capture</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to capture package photos. Contact your admin to request
          the <code className="text-neutral-200">ship.capture_package_photo</code> grant (Shipping
          Clerk or Pharmacy Technician role).
        </p>
      </main>
    );
  }

  const recent = await listRecentPackagePhotoCaptures({
    organizationId: session.tenancy.organizationId,
    capturedByUserId: session.operator.userId,
    limit: 10,
  });

  const flashKey = typeof params.flash === "string" ? params.flash : null;
  const flashBanner = flashKey !== null ? (DOCK_FLASH_BANNERS[flashKey] ?? null) : null;
  const flashPhotoId = typeof params.photoId === "string" ? params.photoId : null;
  const flashMatchedOrderId =
    typeof params.matchedOrderId === "string" ? params.matchedOrderId : null;

  // The error flash carries `<CODE>:<message>` so the operator can
  // tell the help-desk what went wrong. We split on the first
  // colon so error messages may contain colons safely.
  const flashError = typeof params.error === "string" ? params.error : null;
  const errorParts = flashError !== null ? splitOnFirstColon(flashError) : null;

  const now = Date.now();

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Dock capture</h1>
        <p className="text-sm text-neutral-400">
          Snap a photo of each sealed package, type the order number off the pick-ticket, and we
          match it to the order. Mobile-friendly: the camera input opens the device camera directly.
        </p>
      </header>

      {flashBanner !== null ? (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            flashBanner.tone === "ok"
              ? "border-emerald-700 bg-emerald-950 text-emerald-200"
              : "border-amber-700 bg-amber-950 text-amber-200"
          }`}
        >
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
          {flashPhotoId !== null && flashMatchedOrderId === null ? (
            <div className="mt-2 text-xs text-neutral-400">
              Capture id <code className="font-mono">{flashPhotoId}</code>
            </div>
          ) : null}
        </div>
      ) : null}

      {errorParts !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          <div className="font-medium">{errorParts.code}</div>
          <div className="text-xs">{errorParts.message}</div>
        </div>
      ) : null}

      <section className="space-y-3">
        <header>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Capture a package
          </h2>
        </header>
        <form
          action="/api/ops/shipping/package-photos/capture"
          method="POST"
          encType="multipart/form-data"
          className="space-y-4 rounded-md border border-neutral-800 bg-neutral-950 p-4"
        >
          <label className="block space-y-1 text-xs text-neutral-400">
            Package photo
            <input
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              required
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-2 text-sm text-neutral-100 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-sm file:text-neutral-100 hover:file:bg-neutral-700"
            />
            <span className="block text-xs text-neutral-500">
              JPEG / PNG / WebP up to 25 MiB. The capture attribute opens the back camera on mobile.
            </span>
          </label>

          <label className="block space-y-1 text-xs text-neutral-400">
            Order number on the package
            <input
              type="text"
              name="pharmacyExternalOrderNumber"
              required
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="e.g. ORD-2026-001234"
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-2 font-mono text-sm text-neutral-100"
            />
            <span className="block text-xs text-neutral-500">
              We auto-match this to an open order. If we can&apos;t find one, the capture lands in
              the unmatched bucket for clerk triage — your photo is still saved.
            </span>
          </label>

          <label className="block space-y-1 text-xs text-neutral-400">
            Manual tracking number <span className="text-neutral-600">(optional)</span>
            <input
              type="text"
              name="manualTrackingNumber"
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. 1Z999AA10123456784"
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-2 font-mono text-sm text-neutral-100"
            />
            <span className="block text-xs text-neutral-500">
              Only fill in when the carrier label was printed outside our system AND no shipment row
              exists yet. Otherwise leave blank — we pull it from the matched order&apos;s shipment.
            </span>
          </label>

          <label className="block space-y-1 text-xs text-neutral-400">
            Notes <span className="text-neutral-600">(optional)</span>
            <textarea
              name="notes"
              rows={2}
              maxLength={2000}
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-2 text-sm text-neutral-100"
              placeholder="e.g. Damage on the box; double-checked seal."
            />
            <span className="block text-xs text-neutral-500">
              Treat as if the patient could read it — notes are envelope-encrypted at rest, but
              don&apos;t include identifiers a clerk wouldn&apos;t put in an order timeline.
            </span>
          </label>

          <div>
            <button
              type="submit"
              className="rounded-md border border-blue-700 bg-blue-900 px-4 py-2 text-sm text-blue-100 hover:bg-blue-800"
            >
              Capture package
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-3">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Your recent captures
          </h2>
          <span className="text-xs text-neutral-500">{recent.length} most recent</span>
        </header>
        {recent.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            No captures yet. Snap your first one above — it will appear here once saved.
          </div>
        ) : (
          <ul className="space-y-2">
            {recent.map((row) => (
              <CaptureRow key={row.photoId} row={row} nowMs={now} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function splitOnFirstColon(value: string): { readonly code: string; readonly message: string } {
  const idx = value.indexOf(":");
  if (idx < 0) return { code: "DOCK_CAPTURE_ERROR", message: value };
  return { code: value.slice(0, idx), message: value.slice(idx + 1) };
}
