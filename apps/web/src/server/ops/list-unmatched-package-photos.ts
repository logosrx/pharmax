// Unmatched-bucket projection — drives `/ops/shipping/unmatched`.
//
// Lists every `package_photo` in the operator's organization that
// did NOT auto-match at capture time (`matched = false`). These are
// the dock captures a clerk must triage: a rep typo on the external
// order number, a capture taken before the order materialized, a
// packing-station test photo, etc. The page lets the clerk pick the
// correct order and dispatch `ResolvePackagePhotoMatch`.
//
// Served from the existing partial-friendly `(organizationId,
// matched)` index. Newest-first so the freshest dock captures —
// the ones a rep is most likely waiting on — surface at the top.
//
// PHI rule:
//
//   - This projection NEVER decrypts `notesEnc`. Notes can carry
//     incidental PHI; the triage surface shows only the structural
//     fields a clerk needs to reconcile a capture against a
//     physical package label: the rep-typed external order number
//     (the thing that failed to match), capture time, who captured
//     it, the site, any manually-typed tracking number, and the
//     storage descriptor triplet (content-type / size / sha
//     prefix) for forensic cross-referencing.
//
//   - The rep-typed `pharmacyExternalOrderNumber` is NOT PHI — it's
//     the pharmacy's own order identifier, printed on the
//     pick-ticket. Surfacing it is the whole point: the clerk reads
//     it, spots the typo, and searches for the intended order.

import "server-only";

import { type PackagePhotoTrackingSource, readInOrgScope } from "@pharmax/database";

export interface UnmatchedPackagePhotoRow {
  readonly photoId: string;
  readonly capturedAt: Date;
  readonly capturedByUserId: string;
  readonly siteId: string;
  /** The rep-typed external order number that failed to auto-match. */
  readonly pharmacyExternalOrderNumber: string;
  /** A manually-typed tracking number, if the rep entered one at capture time. */
  readonly trackingNumber: string | null;
  readonly trackingSource: PackagePhotoTrackingSource | null;
  readonly contentType: string;
  readonly fileSize: number;
  readonly sha256: string;
}

export interface ListUnmatchedPackagePhotosResult {
  readonly rows: ReadonlyArray<UnmatchedPackagePhotoRow>;
  /** True when the LIMIT was hit — the page shows a "narrow your view" hint. */
  readonly truncated: boolean;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function listUnmatchedPackagePhotos(input: {
  readonly organizationId: string;
  readonly limit?: number;
}): Promise<ListUnmatchedPackagePhotosResult> {
  const limit = clampLimit(input.limit);

  return readInOrgScope(input.organizationId, async (tx) => {
    // Over-fetch by one so we can report truncation without a
    // second COUNT query.
    const rows = await tx.packagePhoto.findMany({
      where: {
        organizationId: input.organizationId,
        matched: false,
      },
      select: {
        id: true,
        capturedAt: true,
        capturedByUserId: true,
        siteId: true,
        pharmacyExternalOrderNumber: true,
        trackingNumber: true,
        trackingSource: true,
        contentType: true,
        fileSize: true,
        sha256: true,
      },
      orderBy: { capturedAt: "desc" },
      take: limit + 1,
    });

    const truncated = rows.length > limit;
    const visible = truncated ? rows.slice(0, limit) : rows;

    return Object.freeze({
      truncated,
      rows: visible.map((r) =>
        Object.freeze({
          photoId: r.id,
          capturedAt: r.capturedAt,
          capturedByUserId: r.capturedByUserId,
          siteId: r.siteId,
          pharmacyExternalOrderNumber: r.pharmacyExternalOrderNumber,
          trackingNumber: r.trackingNumber,
          trackingSource: r.trackingSource,
          contentType: r.contentType,
          fileSize: r.fileSize,
          sha256: r.sha256,
        })
      ),
    });
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
