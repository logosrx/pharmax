// shipping.package_photo.captured.v1 — a packaging photo was uploaded.
//
// Producer: `CapturePackagePhoto` (`@pharmax/package-capture`).
// Consumers: dispatch dashboard preview; carrier-side dispute
//   evidence; future patient-portal "we packed your shipment"
//   reassurance feed.
//
// PHI: none. The photo BYTES live in S3 (referenced by SHA256
// hash); `notes` (free text) is intentionally REDACTED from the
// payload — if present, it's encrypted as `notesEnc` on the
// `package_photo` row.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const MATCH_STRATEGIES = ["EXTERNAL_ORDER_NUMBER", "MANUAL_TRACKING", "UNMATCHED"] as const;
const TRACKING_SOURCES = ["ORDER", "MANUAL"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    photoId: z.uuid(),
    /**
     * `true` when the photo was bound to an order at capture
     * time (e.g. scanned tracking barcode matched an order row).
     */
    matched: z.boolean(),
    matchStrategy: z.enum(MATCH_STRATEGIES),
    /** Matched order id; null when `matched === false`. */
    matchedOrderId: z.uuid().nullable(),
    /** Patient id of the matched order; null when unmatched. */
    matchedPatientId: z.uuid().nullable(),
    /** Whether a tracking number was discovered (scanned or typed). */
    trackingNumberPresent: z.boolean(),
    /**
     * Where the tracking number came from. Null when no number
     * was discovered.
     */
    trackingSource: z.enum(TRACKING_SOURCES).nullable(),
    /** Originating shipment id (when tracking source = ORDER). */
    sourceShipmentId: z.uuid().nullable(),
    /** Lowercase hex SHA256 of the uploaded image. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Stored size in bytes. */
    fileSize: z.number().int().min(0),
    capturedAt: z.iso.datetime({ offset: true }),
    capturedByUserId: z.uuid(),
  })
  .strict();

export const ShippingPackagePhotoCapturedV1 = defineEvent({
  name: "shipping.package_photo.captured",
  version: 1,
  aggregateType: "PackagePhoto",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.photoId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "shipment.dispatch",
  description:
    "Emitted by CapturePackagePhoto after a dispatch photo is stored. Carries the matched order/patient ids + image SHA256; never the photo bytes or the free-text notes.",
});

export type ShippingPackagePhotoCapturedV1Payload = z.infer<typeof payloadSchema>;
