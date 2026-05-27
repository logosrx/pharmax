// CapturePackagePhoto — write the pre-shipment package-photo
// capture record.
//
// Flow:
//
//   The shipping rep snaps a photo on the dock and types the
//   pharmacy's external order number (the upstream id printed on
//   the pick ticket). The rep's client:
//
//     1. Calls `PackagePhotoStorage.beginUpload({ bytes, ... })`,
//        receiving an opaque `uploadToken` plus storage metadata.
//     2. Dispatches THIS command via the bus with the
//        `uploadToken` (the bytes never traverse the bus).
//
//   The command:
//     a. Resolves the `uploadToken` to bytes-metadata. Unknown /
//        expired tokens fail with PACKAGE_PHOTO_UPLOAD_TOKEN_*.
//     b. Cross-checks the resolved upload's `organizationId`
//        matches the caller's tenancy — defends against a leaked
//        token being redeemed by a different tenant.
//     c. Looks up the matched `Order` row by
//        (organizationId, externalOrderNumber). When found, the
//        photo is linked to the matched order + patient and the
//        most recent shipment's `trackingNumber` becomes the
//        auto-resolved tracking number.
//     d. (Optional) Encrypts rep notes via @pharmax/crypto when
//        present.
//     e. Inserts the `package_photo` row in the same tx as the
//        bus's command_log / audit_log / event_outbox writes.
//
//   On `(organizationId, sha256)` collision (rep retook the
//   identical photo), the command surfaces a typed
//   `PACKAGE_PHOTO_DUPLICATE_BYTES` ConflictError carrying the
//   existing photo id. UI can treat this as success ("you've
//   already captured this photo").
//
// What this command does NOT do (deferred to follow-up commands):
//
//   - Update an `Order` workflow state. Capturing a photo is an
//     observation, not a state transition. The order's status is
//     untouched.
//   - Increment `order.version`. Same reason — no state mutation.
//   - Write an `order_event` row. Order timeline rendering can
//     JOIN `package_photo` directly when displaying an order; the
//     workflow event ledger stays exclusive to status changes.
//   - Resolve unmatched photos. A future
//     `ResolvePackagePhotoMatch` command (Phase 5b) lets an
//     operator manually link an unmatched photo to an order.
//
// PHI rule:
//
//   - `notes` (operator's free-text notes) MAY contain PHI; it's
//     listed in `redactFields` so `command_log.requestPayload`
//     stores `[Redacted]`. The persisted column `notesEnc` is
//     envelope-encrypted with the standard
//     {tenantId, "package_photo", "notes", recordId} binding.
//   - `pharmacyExternalOrderNumber` is NOT PHI by convention —
//     it's the clinic's external order id, same shape as
//     `Order.externalOrderNumber` (which is plaintext).
//   - The upload token is opaque; the storage adapter holds the
//     real S3 metadata behind it.
//   - Audit metadata + outbox payload echo only structural fields
//     (photoId, matched, matchStrategy, trackingSource,
//     hasNotes); never the notes plaintext.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { ulid } from "ulid";
import { z } from "zod";

import { getPackagePhotoStorage } from "../storage/configure.js";

// ---------------------------------------------------------------------------
// Error codes (re-exported from index.ts).
// ---------------------------------------------------------------------------

export const PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN = "PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN";
export const PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH =
  "PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH";
export const PACKAGE_PHOTO_DUPLICATE_BYTES = "PACKAGE_PHOTO_DUPLICATE_BYTES";

// ---------------------------------------------------------------------------
// Input / output.
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    /** Token returned by `PackagePhotoStorage.beginUpload`. The
     *  bytes were already uploaded; the command resolves the
     *  token to metadata and persists the row. */
    uploadToken: z.string().min(8).max(256),
    /** Pharmacy's external order number (typed by the rep). May
     *  match an `Order.externalOrderNumber`; if not, the row is
     *  saved as UNMATCHED. */
    pharmacyExternalOrderNumber: z.string().min(1).max(128),
    /** Optional manual tracking number override. When set, takes
     *  precedence over the auto-resolved value from the matched
     *  order's most recent shipment. */
    manualTrackingNumber: z.string().min(4).max(64).optional(),
    /** Optional workstation context (workstation-attached scanner
     *  station). Mobile capture leaves this undefined. */
    workstationId: z.uuid().optional(),
    /** Optional rep notes. May contain PHI; redacted from
     *  `command_log` and envelope-encrypted on the row. */
    notes: z.string().min(1).max(500).optional(),
  })
  .strict();

export type CapturePackagePhotoInput = z.infer<typeof inputSchema>;

export interface CapturePackagePhotoOutput {
  readonly photoId: string;
  readonly matched: boolean;
  readonly matchedOrderId: string | null;
  readonly matchedPatientId: string | null;
  readonly trackingNumber: string | null;
  readonly trackingSource: "ORDER" | "MANUAL" | null;
  readonly storageBucket: string;
  readonly storageKey: string;
  readonly sha256: string;
}

const REDACT_FIELDS = Object.freeze(["notes"] as const);

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export const CapturePackagePhoto: Command<CapturePackagePhotoInput, CapturePackagePhotoOutput> = {
  name: "CapturePackagePhoto",
  inputSchema,
  permission: PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CapturePackagePhotoOutput>> {
    // -------------------------------------------------------------
    // 1. Resolve the upload token.
    // -------------------------------------------------------------
    const storage = getPackagePhotoStorage();
    const upload = await storage.resolveUploadToken(input.uploadToken);
    if (upload === null) {
      throw new errors.NotFoundError({
        code: PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN,
        message:
          "Upload token is unknown or has expired. Re-upload the photo and call again with the new token.",
      });
    }
    if (upload.organizationId !== ctx.organizationId) {
      // Defends against a leaked token redeemed by another tenant.
      // The storage layer is org-segmented at the key level, but
      // we still verify here because the token surface is opaque
      // to the bus.
      throw new errors.AuthorizationError({
        code: PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH,
        message: "Upload token does not belong to the active tenancy.",
      });
    }

    // -------------------------------------------------------------
    // 2. Resolve the optional Order + Patient match.
    // -------------------------------------------------------------
    const matchedOrder = await tx.order.findFirst({
      where: {
        organizationId: ctx.organizationId,
        externalOrderNumber: input.pharmacyExternalOrderNumber,
      },
      select: {
        id: true,
        patientId: true,
        clinicId: true,
        siteId: true,
      },
    });

    const now = clock.now();
    const matched = matchedOrder !== null;

    // -------------------------------------------------------------
    // 3. Resolve the tracking number.
    //
    //    Manual takes precedence over auto-resolved-from-order.
    //    When neither path supplies a value, the row is persisted
    //    with trackingNumber=null and trackingSource=null.
    // -------------------------------------------------------------
    let trackingNumber: string | null = null;
    let trackingSource: "ORDER" | "MANUAL" | null = null;
    let sourceShipmentId: string | null = null;

    if (input.manualTrackingNumber !== undefined) {
      trackingNumber = input.manualTrackingNumber;
      trackingSource = "MANUAL";
    } else if (matchedOrder !== null) {
      // Newest shipment wins. A re-shipped order has multiple
      // shipments; the most recent createdAt is the right tracker
      // for the photo being captured right now.
      const shipment = await tx.shipment.findFirst({
        where: {
          organizationId: ctx.organizationId,
          orderId: matchedOrder.id,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, trackingNumber: true },
      });
      if (shipment !== null) {
        trackingNumber = shipment.trackingNumber;
        trackingSource = "ORDER";
        sourceShipmentId = shipment.id;
      }
    }

    // -------------------------------------------------------------
    // 4. (Optional) encrypt notes.
    // -------------------------------------------------------------
    const photoId = ulid();
    const notesEnc =
      input.notes === undefined
        ? null
        : ((await encryptField({
            plaintext: input.notes,
            binding: {
              tenantId: ctx.organizationId,
              table: "package_photo",
              column: "notes",
              recordId: photoId,
            },
          })) as unknown as Prisma.InputJsonValue);

    // -------------------------------------------------------------
    // 5. Insert the row.
    //
    //    On `(organizationId, sha256)` collision (P2002), surface
    //    PACKAGE_PHOTO_DUPLICATE_BYTES with the existing photo id
    //    so the UI can treat the duplicate retake as success.
    // -------------------------------------------------------------
    try {
      await tx.packagePhoto.create({
        data: {
          id: photoId,
          organizationId: ctx.organizationId,
          siteId: matchedOrder?.siteId ?? requireCallerSiteId(ctx),
          ...(matchedOrder?.clinicId !== undefined ? { clinicId: matchedOrder.clinicId } : {}),
          capturedByUserId: ctx.actor.userId,
          ...(input.workstationId !== undefined
            ? { capturedAtWorkstationId: input.workstationId }
            : {}),
          pharmacyExternalOrderNumber: input.pharmacyExternalOrderNumber,
          matched,
          matchStrategy: matched ? "EXTERNAL_ORDER_NUMBER" : "UNMATCHED",
          ...(matched && matchedOrder !== null
            ? {
                matchedOrderId: matchedOrder.id,
                matchedPatientId: matchedOrder.patientId,
                matchedAt: now,
              }
            : {}),
          ...(trackingNumber !== null ? { trackingNumber } : {}),
          ...(trackingSource !== null ? { trackingSource } : {}),
          ...(sourceShipmentId !== null ? { sourceShipmentId } : {}),
          storageBucket: upload.bucket,
          storageKey: upload.key,
          contentType: upload.contentType,
          fileSize: upload.fileSize,
          sha256: upload.sha256,
          ...(notesEnc !== null ? { notesEnc } : {}),
          capturedAt: now,
          commandLogId,
        },
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        // Find the prior row so the conflict carries an actionable id.
        const prior = await tx.packagePhoto.findFirst({
          where: { organizationId: ctx.organizationId, sha256: upload.sha256 },
          select: { id: true },
        });
        throw new errors.ConflictError({
          code: PACKAGE_PHOTO_DUPLICATE_BYTES,
          message:
            "An identical photo (same sha256) already exists for this organization. The existing photo id is returned in metadata.",
          metadata: {
            sha256: upload.sha256,
            existingPhotoId: prior?.id ?? null,
          },
          cause,
        });
      }
      throw cause;
    }

    // -------------------------------------------------------------
    // 6. Return the bus result. Audit + outbox carry only
    //    structural fields — no notes plaintext, no storage key
    //    (treated opaque), no PHI.
    // -------------------------------------------------------------
    return {
      output: {
        photoId,
        matched,
        matchedOrderId: matched && matchedOrder !== null ? matchedOrder.id : null,
        matchedPatientId: matched && matchedOrder !== null ? matchedOrder.patientId : null,
        trackingNumber,
        trackingSource,
        storageBucket: upload.bucket,
        storageKey: upload.key,
        sha256: upload.sha256,
      },
      audit: {
        action: "shipping.package_photo.captured",
        resourceType: "PackagePhoto",
        resourceId: photoId,
        metadata: {
          photoId,
          pharmacyExternalOrderNumber: input.pharmacyExternalOrderNumber,
          matched,
          matchStrategy: matched ? "EXTERNAL_ORDER_NUMBER" : "UNMATCHED",
          matchedOrderId: matched && matchedOrder !== null ? matchedOrder.id : null,
          trackingSource,
          trackingNumberPresent: trackingNumber !== null,
          hasNotes: input.notes !== undefined,
          hasWorkstationContext: input.workstationId !== undefined,
          sha256: upload.sha256,
          fileSize: upload.fileSize,
          contentType: upload.contentType,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "shipping.package_photo.captured.v1",
          aggregateType: "PackagePhoto",
          aggregateId: photoId,
          payload: {
            organizationId: ctx.organizationId,
            photoId,
            matched,
            matchStrategy: matched ? "EXTERNAL_ORDER_NUMBER" : "UNMATCHED",
            matchedOrderId: matched && matchedOrder !== null ? matchedOrder.id : null,
            matchedPatientId: matched && matchedOrder !== null ? matchedOrder.patientId : null,
            trackingNumberPresent: trackingNumber !== null,
            trackingSource,
            sourceShipmentId,
            sha256: upload.sha256,
            fileSize: upload.fileSize,
            capturedAt: now.toISOString(),
            capturedByUserId: ctx.actor.userId,
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Capture-context site resolver.
 *
 * When the typed external order number matches a real Order, the
 * photo inherits that order's `siteId`. When it does NOT match,
 * the photo still belongs to A site (the dock the rep is
 * standing at). Today, `TenancyContext` does not carry a
 * mandatory `siteId`. Until that landed (tracked in Phase 5b),
 * unmatched captures require `siteId` on the locked grant: a
 * site-pinned ShippingClerk has it; an org-wide service identity
 * doesn't, and an unmatched capture from such an identity will
 * fail loudly here rather than silently insert with an arbitrary
 * site.
 *
 * We surface the missing-site case as `InternalError` (not user
 * error) because the only callers without a `siteId` in scope are
 * service identities — a human shipping clerk's grant is always
 * site-scoped.
 */
function requireCallerSiteId(ctx: { siteId?: string | null }): string {
  if (typeof ctx.siteId === "string" && ctx.siteId.length > 0) {
    return ctx.siteId;
  }
  throw new errors.InternalError({
    code: "PACKAGE_PHOTO_CAPTURE_SITE_REQUIRED",
    message:
      "CapturePackagePhoto could not resolve a siteId for an unmatched capture. The caller's tenancy context must include siteId, or the typed external order number must match an existing Order.",
  });
}
