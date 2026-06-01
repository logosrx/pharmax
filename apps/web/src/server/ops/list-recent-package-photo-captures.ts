// Recent-captures projection for the dock page.
//
// Renders the operator's last N package-photo captures so they
// can verify a capture landed (matched / unmatched / duplicate)
// without having to navigate to the order timeline. Strictly
// scoped to:
//
//   - The active organization (RLS + explicit `where`).
//   - The active operator (`capturedByUserId`). A rep working
//     two simultaneous shifts on different sites should still see
//     all of their own captures; a rep should NEVER see a peer's
//     captures via this projection. Peer-visibility is the
//     unmatched-bucket UI's job (with its own RBAC gate).
//
// PHI rule:
//
//   - This projection deliberately does NOT decrypt the
//     envelope-encrypted `notesEnc` column. Notes can carry
//     incidental PHI (rep typed "patient seemed confused"); the
//     dock page surface should never show plaintext notes. We
//     surface only the structural fields the rep needs to verify
//     "did my last snap land?": photoId, externalOrderNumber,
//     match metadata, tracking metadata, capturedAt.
//
//   - We DO carry the matched patient/order ids through. They are
//     non-PHI (opaque uuids) and the dock page renders them as
//     deep-links into the order detail view, where the
//     PHI-decrypting read happens with the order's own RBAC gate.

import "server-only";

import {
  type PackagePhotoMatchStrategy,
  type PackagePhotoTrackingSource,
  readInOrgScope,
} from "@pharmax/database";

export interface RecentPackagePhotoCapture {
  readonly photoId: string;
  readonly capturedAt: Date;
  readonly pharmacyExternalOrderNumber: string;
  readonly matched: boolean;
  readonly matchStrategy: PackagePhotoMatchStrategy;
  readonly matchedOrderId: string | null;
  readonly matchedPatientId: string | null;
  readonly trackingNumber: string | null;
  readonly trackingSource: PackagePhotoTrackingSource | null;
  readonly sha256: string;
  readonly contentType: string;
  readonly fileSize: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function listRecentPackagePhotoCaptures(input: {
  readonly organizationId: string;
  readonly capturedByUserId: string;
  readonly limit?: number;
}): Promise<ReadonlyArray<RecentPackagePhotoCapture>> {
  const limit = clampLimit(input.limit);

  return readInOrgScope(input.organizationId, async (tx) => {
    const rows = await tx.packagePhoto.findMany({
      where: {
        organizationId: input.organizationId,
        capturedByUserId: input.capturedByUserId,
      },
      select: {
        id: true,
        capturedAt: true,
        pharmacyExternalOrderNumber: true,
        matched: true,
        matchStrategy: true,
        matchedOrderId: true,
        matchedPatientId: true,
        trackingNumber: true,
        trackingSource: true,
        sha256: true,
        contentType: true,
        fileSize: true,
      },
      // Index `(organizationId, capturedByUserId, capturedAt)` makes
      // this a single index range scan; LIMIT pushes down.
      orderBy: { capturedAt: "desc" },
      take: limit,
    });

    return rows.map((r) =>
      Object.freeze({
        photoId: r.id,
        capturedAt: r.capturedAt,
        pharmacyExternalOrderNumber: r.pharmacyExternalOrderNumber,
        matched: r.matched,
        matchStrategy: r.matchStrategy,
        matchedOrderId: r.matchedOrderId,
        matchedPatientId: r.matchedPatientId,
        trackingNumber: r.trackingNumber,
        trackingSource: r.trackingSource,
        sha256: r.sha256,
        contentType: r.contentType,
        fileSize: r.fileSize,
      })
    );
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
