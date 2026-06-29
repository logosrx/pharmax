// /ops/shipping/unmatched — package-photo triage bucket.
//
// Clerk-facing companion to dock capture. Unmatched captures land here;
// the clerk picks one ("?photoId="), searches candidate orders (GET),
// and confirms a match (ResolvePackagePhotoMatch) or archives it.
//
// RBAC: `ship.resolve_package_photo_match` (ShippingClerk), with
// `ship.archive_package_photo` gating archive. PHI: nothing decrypted;
// the rep-typed external order number + non-PHI order context only.

import Link from "next/link";

import { type PackagePhotoTrackingSource } from "@pharmax/database";
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
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, Select, inputClass } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { priorityMeta, statusMeta } from "../../../../src/components/ui/workflow.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

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
function trackingLabel(source: PackagePhotoTrackingSource | null): string {
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
function splitOnFirstColon(value: string): { readonly code: string; readonly message: string } {
  const idx = value.indexOf(":");
  if (idx < 0) return { code: "RESOLVE_ERROR", message: value };
  return { code: value.slice(0, idx), message: value.slice(idx + 1) };
}

const RESOLVE_FLASH: Readonly<Record<string, { title: string; body: string }>> = {
  resolved: {
    title: "Matched",
    body: "The capture is now linked to the order and has left the unmatched bucket.",
  },
  archived: { title: "Archived", body: "The capture is dispositioned out of the triage bucket." },
  archived_noop: {
    title: "Already archived",
    body: "This capture was already archived. No change was made.",
  },
};

const ARCHIVE_REASON_OPTIONS = [
  { value: "TEST_CAPTURE", label: "Test capture" },
  { value: "DUPLICATE", label: "Duplicate" },
  { value: "CAPTURED_IN_ERROR", label: "Captured in error" },
  { value: "UNRESOLVABLE", label: "Unresolvable (no order)" },
];

function UnmatchedRow({
  row,
  nowMs,
  isSelected,
  canArchive,
}: {
  readonly row: UnmatchedPackagePhotoRow;
  readonly nowMs: number;
  readonly isSelected: boolean;
  readonly canArchive: boolean;
}) {
  return (
    <Card accent={isSelected ? "brand" : undefined}>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">UNMATCHED</Badge>
            <span className="text-xs text-subtle">typed</span>
            <code className="font-mono text-sm text-fg">{row.pharmacyExternalOrderNumber}</code>
            <span className="text-xs text-subtle">
              {formatDuration(nowMs - row.capturedAt.getTime())} ago
            </span>
          </div>
          {isSelected ? (
            <Link href="/ops/shipping/unmatched" className="text-xs text-muted hover:text-fg">
              Close
            </Link>
          ) : (
            <Link
              href={`/ops/shipping/unmatched?photoId=${encodeURIComponent(row.photoId)}`}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Work this →
            </Link>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-3">
          {/* Authenticated byte-proxy thumbnail — plain <img> is intentional. */}
          <img
            src={`/api/ops/shipping/package-photos/${row.photoId}/image`}
            alt="Sealed package"
            loading="lazy"
            className="h-24 w-auto shrink-0 rounded-md border border-line bg-surface-2 object-contain"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
            <span>
              tracking: {trackingLabel(row.trackingSource)}
              {row.trackingNumber !== null ? (
                <>
                  {" "}
                  — <code className="font-mono text-muted">{row.trackingNumber}</code>
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
          <ActionForm
            action="/api/ops/shipping/unmatched/archive"
            className="flex flex-wrap items-end gap-2 border-t border-line pt-2"
          >
            <input type="hidden" name="photoId" value={row.photoId} />
            <Field label="Archive reason">
              <Select name="reason" defaultValue="TEST_CAPTURE">
                {ARCHIVE_REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton variant="danger" size="sm" icon="x">
              Archive
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CandidateRow({
  candidate,
  photoId,
  nowMs,
}: {
  readonly candidate: OrderMatchCandidate;
  readonly photoId: string;
  readonly nowMs: number;
}) {
  const pm = priorityMeta(candidate.priority);
  const sm = statusMeta(candidate.currentStatus);
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/ops/orders/${candidate.orderId}`}
              className="font-mono text-sm text-fg hover:text-brand"
            >
              {candidate.externalOrderNumber ?? candidate.orderId}
            </Link>
            <Badge tone={pm.tone}>{pm.label}</Badge>
            <Badge tone={sm.tone}>{sm.label}</Badge>
          </div>
          <div className="text-xs text-subtle">
            Received {formatDuration(nowMs - candidate.receivedAt.getTime())} ago
            {candidate.hasShipment ? (
              <span className="text-emerald-400"> · has shipment</span>
            ) : (
              <span> · no shipment yet</span>
            )}
          </div>
        </div>
        <ActionForm action="/api/ops/shipping/unmatched/resolve">
          <input type="hidden" name="photoId" value={photoId} />
          <input type="hidden" name="targetOrderId" value={candidate.orderId} />
          <SubmitButton variant="go" size="sm" icon="check">
            Match to this order
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

export default async function UnmatchedTriagePage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly photoId?: string;
    readonly q?: string;
    readonly flash?: string;
    readonly matchedOrderId?: string;
    readonly error?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  const canArchive = hasOperatorPermission(permissions, PERMISSIONS.SHIP_ARCHIVE_PACKAGE_PHOTO);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Fulfillment" title="Unmatched package photos" />
        <PermissionDenied grant="ship.resolve_package_photo_match" role="Shipping Clerk" />
      </div>
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
  const candidates =
    selectedPhoto !== null && query.trim().length > 0
      ? await searchOrdersForPhotoMatch({ organizationId: session.tenancy.organizationId, query })
      : null;

  const flashKey = typeof params.flash === "string" ? params.flash : null;
  const flashBanner = flashKey !== null ? (RESOLVE_FLASH[flashKey] ?? null) : null;
  const flashMatchedOrderId =
    typeof params.matchedOrderId === "string" ? params.matchedOrderId : null;
  const flashError = typeof params.error === "string" ? params.error : null;
  const errorParts = flashError !== null ? splitOnFirstColon(flashError) : null;
  const now = Date.now();

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Fulfillment"
        title="Unmatched package photos"
        description="Dock captures that didn't auto-match. Pick a capture, find the intended order (search or scan), and confirm the match. The photo's capture-time choices are preserved."
      />

      {flashBanner !== null ? (
        <Banner tone="success" title={flashBanner.title}>
          {flashBanner.body}
          {flashMatchedOrderId !== null ? (
            <div className="mt-1">
              <Link
                href={`/ops/orders/${flashMatchedOrderId}`}
                className="font-medium underline underline-offset-2"
              >
                Open the matched order →
              </Link>
            </div>
          ) : null}
        </Banner>
      ) : null}
      {errorParts !== null ? (
        <Banner tone="danger" title={errorParts.code}>
          {errorParts.message}
          {flashMatchedOrderId !== null ? (
            <div className="mt-1">
              <Link
                href={`/ops/orders/${flashMatchedOrderId}`}
                className="font-medium underline underline-offset-2"
              >
                See the existing match →
              </Link>
            </div>
          ) : null}
        </Banner>
      ) : null}

      {selectedPhoto !== null ? (
        <Card accent="brand">
          <CardContent className="space-y-4">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
                Resolve capture
              </h2>
              <p className="mt-1 text-xs text-muted">
                Rep typed{" "}
                <code className="font-mono text-fg">
                  {selectedPhoto.pharmacyExternalOrderNumber}
                </code>{" "}
                — captured {formatDuration(now - selectedPhoto.capturedAt.getTime())} ago. Find the
                order it should have matched.
              </p>
            </div>

            <form method="GET" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="photoId" value={selectedPhoto.photoId} />
              <Field label="Order number (type or scan)" className="flex-1">
                <input
                  type="text"
                  name="q"
                  defaultValue={query}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="ORD-2026-001234"
                  className={inputClass("font-mono")}
                />
              </Field>
              <button type="submit" className={buttonClass({ variant: "primary" })}>
                <Icon name="search" size={16} />
                Search orders
              </button>
            </form>

            {candidates !== null ? (
              candidates.tooShort ? (
                <p className="text-xs text-subtle">
                  Type at least 2 characters of the order number to search.
                </p>
              ) : candidates.rows.length === 0 ? (
                <EmptyState
                  icon="search"
                  title={`No orders match "${query}"`}
                  description="Check the number on the package label, or the order may not have been entered yet."
                />
              ) : (
                <div className="space-y-2">
                  {candidates.truncated ? (
                    <p className="text-xs text-amber-300">
                      Showing the first 25 matches — refine to narrow.
                    </p>
                  ) : null}
                  {candidates.rows.map((c) => (
                    <CandidateRow
                      key={c.orderId}
                      candidate={c}
                      photoId={selectedPhoto.photoId}
                      nowMs={now}
                    />
                  ))}
                </div>
              )
            ) : (
              <p className="text-xs text-subtle">
                Search for the intended order above to see candidates.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Section
        title="Unmatched bucket"
        count={`${unmatched.rows.length}${unmatched.truncated ? "+" : ""}`}
      >
        {unmatched.truncated ? (
          <Banner tone="warning">
            Showing the most recent {unmatched.rows.length} unmatched captures. Work the bucket down
            to see older ones.
          </Banner>
        ) : null}
        {unmatched.rows.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing to triage"
            description="Every dock capture has matched an order. Nice."
          />
        ) : (
          <div className="space-y-2">
            {unmatched.rows.map((row) => (
              <UnmatchedRow
                key={row.photoId}
                row={row}
                nowMs={now}
                isSelected={row.photoId === selectedPhotoId}
                canArchive={canArchive}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
