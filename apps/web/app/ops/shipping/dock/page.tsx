// /ops/shipping/dock — pre-shipment package-photo capture surface.
//
// The shipping rep snaps a photo of each sealed package and types the
// external order number off the pick-ticket. The form posts to
// /api/ops/shipping/package-photos/capture (beginUpload +
// CapturePackagePhoto) and redirects back with a typed flash. The
// operator's last 10 captures show match status.
//
// PHI: never decrypts notes; recent captures show structural metadata
// only. Flash carries opaque ids only. Gate:
// `ship.capture_package_photo`.

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
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, inputClass, textareaClass } from "../../../../src/components/ui/field.js";
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

function matchMeta(
  matched: boolean,
  strategy: PackagePhotoMatchStrategy
): { tone: Tone; label: string } {
  if (!matched) return { tone: "warning", label: "UNMATCHED" };
  switch (strategy) {
    case "EXTERNAL_ORDER_NUMBER":
      return { tone: "success", label: "AUTO-MATCHED" };
    case "MANUAL_ORDER_ID":
      return { tone: "info", label: "RESOLVED · ORDER" };
    case "MANUAL_PATIENT_ID":
      return { tone: "info", label: "RESOLVED · PATIENT" };
    default:
      return { tone: "warning", label: "UNMATCHED" };
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
    default:
      return source;
  }
}

function CaptureRow({
  row,
  nowMs,
}: {
  readonly row: RecentPackagePhotoCapture;
  readonly nowMs: number;
}) {
  const meta = matchMeta(row.matched, row.matchStrategy);
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <code className="font-mono text-sm text-fg">{row.pharmacyExternalOrderNumber}</code>
          <span className="text-xs text-subtle">
            {formatDuration(nowMs - row.capturedAt.getTime())} ago
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          {row.matched && row.matchedOrderId !== null ? (
            <Link href={`/ops/orders/${row.matchedOrderId}`} className="text-brand hover:underline">
              View order →
            </Link>
          ) : null}
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
      </CardContent>
    </Card>
  );
}

function splitOnFirstColon(value: string): { readonly code: string; readonly message: string } {
  const idx = value.indexOf(":");
  if (idx < 0) return { code: "DOCK_CAPTURE_ERROR", message: value };
  return { code: value.slice(0, idx), message: value.slice(idx + 1) };
}

const DOCK_FLASH: Readonly<
  Record<string, { tone: "success" | "warning"; title: string; body: string }>
> = {
  matched: {
    tone: "success",
    title: "Captured and matched",
    body: "Photo saved and linked to the matching order. Keep packing.",
  },
  unmatched: {
    tone: "warning",
    title: "Captured but not matched",
    body: "Saved the photo but couldn't find an order for that number. A clerk will triage it — verify the order number on the next package.",
  },
  duplicate: {
    tone: "success",
    title: "Already captured",
    body: "This exact photo is already on file — nothing to do.",
  },
};

export default async function DockCapturePage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly flash?: string;
    readonly photoId?: string;
    readonly matchedOrderId?: string;
    readonly error?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Fulfillment" title="Dock capture" />
        <PermissionDenied
          grant="ship.capture_package_photo"
          role="Shipping Clerk / Pharmacy Technician"
        />
      </div>
    );
  }

  const recent = await listRecentPackagePhotoCaptures({
    organizationId: session.tenancy.organizationId,
    capturedByUserId: session.operator.userId,
    limit: 10,
  });

  const flashKey = typeof params.flash === "string" ? params.flash : null;
  const flashBanner = flashKey !== null ? (DOCK_FLASH[flashKey] ?? null) : null;
  const flashMatchedOrderId =
    typeof params.matchedOrderId === "string" ? params.matchedOrderId : null;
  const flashError = typeof params.error === "string" ? params.error : null;
  const errorParts = flashError !== null ? splitOnFirstColon(flashError) : null;
  const now = Date.now();

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Fulfillment"
        title="Dock capture"
        description="Snap a photo of each sealed package, type the order number off the pick-ticket, and we match it to the order. Mobile-friendly — the camera input opens the device camera directly."
      />

      {flashBanner !== null ? (
        <Banner tone={flashBanner.tone} title={flashBanner.title}>
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
        </Banner>
      ) : null}

      <Section title="Capture a package">
        <Card>
          <CardContent>
            <ActionForm
              action="/api/ops/shipping/package-photos/capture"
              encType="multipart/form-data"
              className="space-y-4"
            >
              <Field
                label="Package photo"
                help="JPEG / PNG / WebP up to 25 MiB. capture opens the back camera on mobile."
              >
                <input
                  type="file"
                  name="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  required
                  className={inputClass(
                    "h-auto py-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-sm file:text-fg"
                  )}
                />
              </Field>
              <Field
                label="Order number on the package"
                help="Auto-matched to an open order. If none is found, the capture lands in the unmatched bucket — your photo is still saved."
              >
                <input
                  type="text"
                  name="pharmacyExternalOrderNumber"
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="ORD-2026-001234"
                  className={inputClass("font-mono")}
                />
              </Field>
              <Field
                label="Manual tracking number"
                help="Only when the label was printed outside our system AND no shipment row exists yet."
              >
                <input
                  type="text"
                  name="manualTrackingNumber"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="1Z999AA10123456784"
                  className={inputClass("font-mono")}
                />
              </Field>
              <Field
                label="Notes"
                help="Envelope-encrypted at rest — but treat as if the patient could read it; no extra identifiers."
              >
                <textarea
                  name="notes"
                  rows={2}
                  maxLength={2000}
                  className={textareaClass()}
                  placeholder="e.g. Damage on the box; double-checked seal."
                />
              </Field>
              <SubmitButton icon="dock">Capture package</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </Section>

      <Section title="Your recent captures" count={recent.length}>
        {recent.length === 0 ? (
          <EmptyState
            icon="dock"
            title="No captures yet"
            description="Snap your first one above — it appears here once saved."
          />
        ) : (
          <div className="space-y-2">
            {recent.map((row) => (
              <CaptureRow key={row.photoId} row={row} nowMs={now} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
