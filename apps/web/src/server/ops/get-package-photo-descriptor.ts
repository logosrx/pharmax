// Storage-descriptor lookup for the package-photo image-stream
// route.
//
// Returns the structural storage pointer for a single
// `package_photo` row, scoped to the operator's organization (RLS +
// explicit `where`). The image route uses this to (a) confirm the
// photo exists in the caller's tenant before touching storage, and
// (b) recover the `(bucket, key)` pointer + the expected sha256 /
// content type.
//
// PHI rule:
//
//   - Structural fields only. NO `notesEnc`, no patient/order ids.
//     The bytes the descriptor points at are not classified PHI in
//     Pharmax's threat model (see package-photo-storage.ts); the
//     descriptor itself is pure storage metadata.
//
// Why a dedicated helper (not getOrderDetail):
//
//   - The image route must serve photos from BOTH the order-detail
//     surface (matched photos) AND the triage surface (UNMATCHED
//     photos, which have no order). Keying the lookup on the photo
//     id alone — not on an order — covers both. The org scope is
//     the isolation boundary.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

export interface PackagePhotoStorageDescriptor {
  readonly photoId: string;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly fileSize: number;
  readonly sha256: string;
}

export async function getPackagePhotoStorageDescriptor(input: {
  readonly organizationId: string;
  readonly photoId: string;
}): Promise<PackagePhotoStorageDescriptor | null> {
  const row = await readInOrgScope(input.organizationId, (tx) =>
    tx.packagePhoto.findFirst({
      where: { id: input.photoId, organizationId: input.organizationId },
      select: {
        id: true,
        storageBucket: true,
        storageKey: true,
        contentType: true,
        fileSize: true,
        sha256: true,
      },
    })
  );

  if (row === null) return null;

  return Object.freeze({
    photoId: row.id,
    bucket: row.storageBucket,
    key: row.storageKey,
    contentType: row.contentType,
    fileSize: row.fileSize,
    sha256: row.sha256,
  });
}
