// ResolvePackagePhotoMatch — manual operator triage for an
// unmatched dock capture.
//
// Flow:
//
//   A shipping rep snapped a photo at the dock. The
//   `CapturePackagePhoto` command tried to auto-match it via the
//   rep-typed `pharmacyExternalOrderNumber` and failed (typo, the
//   order didn't exist yet, the photo was for a packing-station
//   test, etc.). The row was persisted with:
//
//     matched = false
//     matchStrategy = UNMATCHED
//     matchedOrderId = null
//     matchedPatientId = null
//     matchedAt = null
//     trackingNumber = null  (typically — operator may have typed
//                              one manually at capture time)
//
//   Later, an operator with `ship.resolve_package_photo_match`
//   reviews the unmatched-bucket queue, identifies the correct
//   order, and dispatches THIS command. The command:
//
//     1. Reads the `package_photo` row (RLS keeps it same-org)
//        and refuses if it's already matched. The terminal update
//        re-checks `matched=false` as a `WHERE` predicate so two
//        operators racing on the same photo cannot both win — the
//        second `updateMany` returns count=0 and we surface
//        `PACKAGE_PHOTO_ALREADY_MATCHED` without explicit locking.
//     2. Loads the target `Order` row in the same tx — RLS
//        guarantees same-org. The fetched fields are the inputs to
//        the back-fill step.
//     3. Updates the photo row in-place:
//        - matched = true
//        - matchStrategy = MANUAL_ORDER_ID  (NOT MANUAL_PATIENT_ID
//          — that strategy is reserved for the patient-search UI
//          path; see migration
//          20260612000000_phase5_package_photo_manual_order_match
//          for the audit-anchor reasoning).
//        - matchedOrderId, matchedPatientId from the order.
//        - matchedAt = clock.now().
//        - clinicId  back-filled from the order IF the photo's
//                    `clinicId` was null at capture time AND the
//                    order has one. We DO NOT overwrite a
//                    pre-existing clinicId — the rep's
//                    capture-time clinic context is the audit
//                    anchor; the operator is RESOLVING, not
//                    re-tagging.
//        - trackingNumber/trackingSource/sourceShipmentId
//                    back-filled from the matched order's most
//                    recent shipment IF the photo had no manual
//                    tracking number at capture time. Same
//                    "don't-overwrite" rule.
//
// What this command does NOT do (deferred):
//
//   - Allow re-matching an already-matched photo. A misclick is
//     fixed by archiving the wrong photo (operator-as-data flag,
//     not in scope here) and capturing a fresh one.
//   - Take an arbitrary patient id (no `targetPatientId` input).
//     That's the future MANUAL_PATIENT_ID strategy's command;
//     operator workflows that start from "I know the patient" use
//     a different UI and a different command.
//   - Update an `Order` workflow state. Same as
//     `CapturePackagePhoto` — observation, not transition.
//
// PHI rule:
//
//   - Inputs are structural ids only (photoId, targetOrderId).
//     No PHI in the request payload, no redactFields needed.
//   - Audit metadata + outbox payload echo only ids and structural
//     deltas (priorMatchStrategy, hasClinicBackfilled,
//     hasTrackingBackfilled). No notes, no patient names, no
//     order numbers.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes (re-exported from index.ts).
// ---------------------------------------------------------------------------

export const PACKAGE_PHOTO_NOT_FOUND = "PACKAGE_PHOTO_NOT_FOUND";
export const PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND = "PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND";
export const PACKAGE_PHOTO_ALREADY_MATCHED = "PACKAGE_PHOTO_ALREADY_MATCHED";

// ---------------------------------------------------------------------------
// Input / output.
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    /** The unmatched `package_photo.id` to resolve. */
    photoId: z.string().min(1).max(64),
    /** The `Order.id` the operator selected as the correct match. */
    targetOrderId: z.uuid(),
  })
  .strict();

export type ResolvePackagePhotoMatchInput = z.infer<typeof inputSchema>;

export interface ResolvePackagePhotoMatchOutput {
  readonly photoId: string;
  readonly matchedOrderId: string;
  readonly matchedPatientId: string;
  readonly clinicId: string | null;
  readonly trackingNumber: string | null;
  readonly trackingSource: "ORDER" | "MANUAL" | null;
  readonly clinicBackfilled: boolean;
  readonly trackingBackfilled: boolean;
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export const ResolvePackagePhotoMatch: Command<
  ResolvePackagePhotoMatchInput,
  ResolvePackagePhotoMatchOutput
> = {
  name: "ResolvePackagePhotoMatch",
  inputSchema,
  permission: PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<ResolvePackagePhotoMatchOutput>> {
    // -------------------------------------------------------------
    // 1. Load the package_photo row.
    //
    //    RLS scopes this to the operator's organization. We fetch
    //    the structural fields needed to compute back-fills; the
    //    terminal update will re-assert `matched=false` so two
    //    operators racing on the same photo cannot both write.
    // -------------------------------------------------------------
    const photo = await tx.packagePhoto.findFirst({
      where: {
        id: input.photoId,
        organizationId: ctx.organizationId,
      },
      select: {
        id: true,
        clinicId: true,
        matched: true,
        matchStrategy: true,
        matchedOrderId: true,
        trackingNumber: true,
        trackingSource: true,
        sourceShipmentId: true,
      },
    });
    if (photo === null) {
      throw new errors.NotFoundError({
        code: PACKAGE_PHOTO_NOT_FOUND,
        message:
          "PackagePhoto not found in the active tenancy. The id may be stale or belong to another organization.",
      });
    }
    if (photo.matched) {
      // Don't allow re-matching. The audit anchor on a captured
      // photo is "this is the package that left the dock for
      // patient X / order Y" — letting a second operator rewrite
      // that anchor turns the photo into a movable target. A
      // misclick is fixed by capturing a fresh photo.
      throw new errors.ConflictError({
        code: PACKAGE_PHOTO_ALREADY_MATCHED,
        message:
          "PackagePhoto is already matched. Re-matching is not allowed; capture a new photo if the existing match is wrong.",
        metadata: {
          photoId: photo.id,
          existingMatchedOrderId: photo.matchedOrderId,
          existingMatchStrategy: photo.matchStrategy,
        },
      });
    }

    // -------------------------------------------------------------
    // 2. Load the target order. RLS keeps this same-org. The
    //    target order does NOT need to be locked — we only READ
    //    the patient/clinic/shipment denormalized fields, and
    //    those are immutable for the lifetime of the photo's
    //    match.
    // -------------------------------------------------------------
    const targetOrder = await tx.order.findFirst({
      where: {
        id: input.targetOrderId,
        organizationId: ctx.organizationId,
      },
      select: {
        id: true,
        patientId: true,
        clinicId: true,
      },
    });
    if (targetOrder === null) {
      throw new errors.NotFoundError({
        code: PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND,
        message:
          "Target Order not found in the active tenancy. Verify the order id and that the operator has access to its clinic.",
      });
    }

    // -------------------------------------------------------------
    // 3. Compute back-fills.
    //
    //    Both clinic and tracking back-fills follow the same
    //    "don't overwrite" rule: the rep's capture-time choice
    //    wins; the operator's RESOLVE action only fills holes.
    // -------------------------------------------------------------
    const clinicBackfilled = photo.clinicId === null && targetOrder.clinicId !== null;
    const finalClinicId = clinicBackfilled ? targetOrder.clinicId : photo.clinicId;

    let trackingBackfilled = false;
    let finalTrackingNumber: string | null = photo.trackingNumber;
    let finalTrackingSource: "ORDER" | "MANUAL" | null =
      photo.trackingSource === "ORDER" || photo.trackingSource === "MANUAL"
        ? photo.trackingSource
        : null;
    let finalSourceShipmentId: string | null = photo.sourceShipmentId;

    if (photo.trackingNumber === null) {
      const shipment = await tx.shipment.findFirst({
        where: {
          organizationId: ctx.organizationId,
          orderId: targetOrder.id,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, trackingNumber: true },
      });
      if (shipment !== null) {
        finalTrackingNumber = shipment.trackingNumber;
        finalTrackingSource = "ORDER";
        finalSourceShipmentId = shipment.id;
        trackingBackfilled = true;
      }
    }

    // -------------------------------------------------------------
    // 4. Apply the update with a race-safe predicate.
    //
    //    `updateMany` lets us require `matched: false` in the
    //    WHERE — Prisma's singular `update` only accepts a unique
    //    constraint. If a second operator beat us between the
    //    findFirst and here, count returns 0 and we surface
    //    PACKAGE_PHOTO_ALREADY_MATCHED.
    // -------------------------------------------------------------
    const now = clock.now();
    const result = await tx.packagePhoto.updateMany({
      where: {
        id: photo.id,
        organizationId: ctx.organizationId,
        matched: false,
      },
      data: {
        matched: true,
        matchStrategy: "MANUAL_ORDER_ID",
        matchedOrderId: targetOrder.id,
        matchedPatientId: targetOrder.patientId,
        matchedAt: now,
        ...(clinicBackfilled && finalClinicId !== null ? { clinicId: finalClinicId } : {}),
        ...(trackingBackfilled
          ? {
              trackingNumber: finalTrackingNumber,
              trackingSource: "ORDER",
              ...(finalSourceShipmentId !== null
                ? { sourceShipmentId: finalSourceShipmentId }
                : {}),
            }
          : {}),
      },
    });
    if (result.count !== 1) {
      // Lost the race. Re-read to give the caller the winner's
      // matched order id (helpful for the UI "did you mean..."
      // path).
      const winner = await tx.packagePhoto.findFirst({
        where: { id: photo.id, organizationId: ctx.organizationId },
        select: { matchedOrderId: true, matchStrategy: true },
      });
      throw new errors.ConflictError({
        code: PACKAGE_PHOTO_ALREADY_MATCHED,
        message:
          "PackagePhoto was matched by another operator while this command ran. Re-matching is not allowed.",
        metadata: {
          photoId: photo.id,
          existingMatchedOrderId: winner?.matchedOrderId ?? null,
          existingMatchStrategy: winner?.matchStrategy ?? null,
        },
      });
    }

    // -------------------------------------------------------------
    // 5. Return.
    //
    //    Audit + outbox carry only structural deltas. The prior
    //    matchStrategy is included so a SOC 2 reviewer can
    //    confirm "this row went UNMATCHED → MANUAL_ORDER_ID" and
    //    didn't, e.g., bypass an EXTERNAL_ORDER_NUMBER row.
    // -------------------------------------------------------------
    return {
      output: {
        photoId: photo.id,
        matchedOrderId: targetOrder.id,
        matchedPatientId: targetOrder.patientId,
        clinicId: finalClinicId,
        trackingNumber: finalTrackingNumber,
        trackingSource: finalTrackingSource,
        clinicBackfilled,
        trackingBackfilled,
      },
      audit: {
        action: "shipping.package_photo.match_resolved",
        resourceType: "PackagePhoto",
        resourceId: photo.id,
        metadata: {
          photoId: photo.id,
          targetOrderId: targetOrder.id,
          matchedPatientId: targetOrder.patientId,
          priorMatchStrategy: photo.matchStrategy,
          newMatchStrategy: "MANUAL_ORDER_ID",
          clinicBackfilled,
          trackingBackfilled,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "shipping.package_photo.match_resolved.v1",
          aggregateType: "PackagePhoto",
          aggregateId: photo.id,
          payload: {
            organizationId: ctx.organizationId,
            photoId: photo.id,
            matchedOrderId: targetOrder.id,
            matchedPatientId: targetOrder.patientId,
            priorMatchStrategy: photo.matchStrategy,
            newMatchStrategy: "MANUAL_ORDER_ID",
            clinicBackfilled,
            trackingBackfilled,
            resolvedAt: now.toISOString(),
            resolvedByUserId: ctx.actor.userId,
          },
        },
      ],
    };
  },
};
