// shipping.package_photo.archived.v1 — a dock capture was
// dispositioned out of the triage bucket / order timeline.
//
// Producer: `ArchivePackagePhoto` (`@pharmax/package-capture`).
// Consumers: unmatched-bucket dashboard (counter decrement); future
//   byte-reclamation pipeline (an archived capture's S3 object may
//   eventually be reclaimed since no live surface references it).
//
// PHI: none. Carries the photo id, the disposition reason, whether
// the row had been matched at archive time, and the archiving
// actor. No notes, no patient/order numbers, no photo bytes.
//
// Why a distinct event (not bundled into match_resolved): archiving
// and resolving are opposite dispositions — resolve BINDS a photo to
// an order, archive REMOVES it from every surface. They have
// different RBAC (`ship.resolve_package_photo_match` vs
// `ship.archive_package_photo`) and different downstream meaning;
// one event with a discriminator would obscure the audit trail.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

// Mirrors `enum PackagePhotoArchiveReason` in `prisma/schema.prisma`.
// Kept in sync manually; the events parity guard catches a drifted
// literal indirectly via the source-emit scan.
const ARCHIVE_REASONS = ["TEST_CAPTURE", "DUPLICATE", "CAPTURED_IN_ERROR", "UNRESOLVABLE"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    photoId: z.uuid(),
    reason: z.enum(ARCHIVE_REASONS),
    /**
     * Whether the photo was matched to an order at archive time.
     * `true` is the "fix a wrong match" path (archive the misclicked
     * photo + recapture); `false` is the "clear an unmatched test /
     * dupe / unresolvable capture" path.
     */
    wasMatched: z.boolean(),
    archivedAt: z.iso.datetime({ offset: true }),
    archivedByUserId: z.uuid(),
  })
  .strict();

export const ShippingPackagePhotoArchivedV1 = defineEvent({
  name: "shipping.package_photo.archived",
  version: 1,
  aggregateType: "PackagePhoto",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.photoId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "shipment.dispatch",
  description:
    "Emitted by ArchivePackagePhoto when an operator dispositions a dock capture (test/duplicate/error/unresolvable) out of the triage bucket and order timeline. Structural ids + reason only; never PHI or photo bytes.",
});

export type ShippingPackagePhotoArchivedV1Payload = z.infer<typeof payloadSchema>;
