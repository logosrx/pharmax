// shipping.package_photo.match_resolved.v1 — an unmatched dock photo
// was manually matched to an order by a triage operator.
//
// Producer: `ResolvePackagePhotoMatch` (`@pharmax/package-capture`).
// Consumers: dispatch unmatched-bucket dashboard (counter decrement);
//   carrier-dispute evidence pipeline (now-bound photo gets included
//   in shipment exception packets); future patient-portal "we packed
//   your shipment" feed.
//
// PHI: none. Carries only structural ids and the prior/new match
// strategy. No notes, no patient names, no order numbers. Photo
// BYTES are not referenced — the `match_resolved` audit anchor is
// "this photo is now bound to that order"; the bytes themselves
// were anchored at `captured` time.
//
// Why not bundle into `package_photo.captured.v1`: capture and
// resolve are two distinct operator actions with different RBAC
// surfaces (`ship.capture_package_photo` vs
// `ship.resolve_package_photo_match`). Carrying both transitions
// on one event would force consumers to branch on a discriminator
// and would obscure the SOC 2 audit trail.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

// Mirrors `enum PackagePhotoMatchStrategy` in `prisma/schema.prisma`.
// Kept in sync manually; the `events:validate` parity guard catches
// schema drift indirectly via the source-emit scan.
const MATCH_STRATEGIES = [
  "EXTERNAL_ORDER_NUMBER",
  "MANUAL_PATIENT_ID",
  "MANUAL_ORDER_ID",
  "UNMATCHED",
] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    photoId: z.uuid(),
    /** Order id chosen by the operator. */
    matchedOrderId: z.uuid(),
    /** Patient id denormalized from the matched order. */
    matchedPatientId: z.uuid(),
    /**
     * Strategy the row carried at capture time. In practice today
     * this is always `UNMATCHED` because the resolve command refuses
     * to re-match already-matched rows, but the schema accepts the
     * full enum so future strategies (`MANUAL_PATIENT_ID`) can
     * transition through this event without a schema bump.
     */
    priorMatchStrategy: z.enum(MATCH_STRATEGIES),
    /** Strategy written by the resolve command. */
    newMatchStrategy: z.enum(MATCH_STRATEGIES),
    /** True when the resolve back-filled `clinicId` from the order. */
    clinicBackfilled: z.boolean(),
    /**
     * True when the resolve back-filled tracking number / source /
     * source shipment id from the order's most recent shipment.
     */
    trackingBackfilled: z.boolean(),
    resolvedAt: z.iso.datetime({ offset: true }),
    resolvedByUserId: z.uuid(),
  })
  .strict();

export const ShippingPackagePhotoMatchResolvedV1 = defineEvent({
  name: "shipping.package_photo.match_resolved",
  version: 1,
  aggregateType: "PackagePhoto",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.photoId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "shipment.dispatch",
  description:
    "Emitted by ResolvePackagePhotoMatch after a triage operator manually binds an unmatched dock photo to an order. Carries the structural strategy transition + back-fill flags; never patient PHI or photo bytes.",
});

export type ShippingPackagePhotoMatchResolvedV1Payload = z.infer<typeof payloadSchema>;
