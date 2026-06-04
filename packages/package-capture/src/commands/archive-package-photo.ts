// ArchivePackagePhoto — disposition a dock capture out of the
// triage bucket and the order timeline.
//
// Flow:
//
//   A capture lands that will NEVER usefully match an order:
//
//     - a packing-station test shot (`TEST_CAPTURE`),
//     - a duplicate retake of a package already captured (`DUPLICATE`),
//     - a wrong photo / misclick / not-actually-a-package
//       (`CAPTURED_IN_ERROR`), or
//     - a genuine capture whose order was cancelled or whose
//       external number no order will ever carry (`UNRESOLVABLE`).
//
//   It also covers the "fix a wrong match" path that
//   `ResolvePackagePhotoMatch` explicitly defers to: a photo matched
//   to the wrong order is archived (not re-matched — the audit
//   anchor must not be a movable target) and a fresh one captured.
//
//   The operator dispatches THIS command with a required reason.
//   The command:
//
//     1. Reads the `package_photo` row (RLS keeps it same-org).
//     2. If already archived → idempotent no-op (returns
//        `alreadyArchived: true`, preserves the original archive
//        metadata + audit anchor, emits NO new outbox event).
//     3. Otherwise stamps `archivedAt` / `archiveReason` /
//        `archivedByUserId` via a race-safe `updateMany` keyed on
//        `archivedAt: null` — two operators racing converge (the
//        loser sees `alreadyArchived: true`, not a conflict, because
//        "make it archived" is idempotent regardless of who won).
//
// Soft delete: the row is RETAINED (audit anchor). Every read
// surface (triage bucket, order timeline, image route's descriptor)
// filters on `archivedAt IS NULL`. The S3 object is left in place;
// byte reclamation for archived captures is a separate concern.
//
// PHI rule:
//
//   - Inputs are a structural id + a reason enum. No PHI, no
//     redactFields needed.
//   - Audit metadata + outbox payload echo only ids + the reason +
//     the matched-at-archive-time flag. No notes, no patient names,
//     no order numbers.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes (re-exported from index.ts).
// ---------------------------------------------------------------------------

export const PACKAGE_PHOTO_ARCHIVE_NOT_FOUND = "PACKAGE_PHOTO_ARCHIVE_NOT_FOUND";

// ---------------------------------------------------------------------------
// Input / output.
// ---------------------------------------------------------------------------

// Mirrors `enum PackagePhotoArchiveReason` in prisma/schema.prisma.
const ARCHIVE_REASONS = ["TEST_CAPTURE", "DUPLICATE", "CAPTURED_IN_ERROR", "UNRESOLVABLE"] as const;

export type PackagePhotoArchiveReason = (typeof ARCHIVE_REASONS)[number];

const inputSchema = z
  .object({
    /** The `package_photo.id` to archive. */
    photoId: z.string().min(1).max(64),
    /** Required disposition reason — every archive carries one. */
    reason: z.enum(ARCHIVE_REASONS),
  })
  .strict();

export type ArchivePackagePhotoInput = z.infer<typeof inputSchema>;

export interface ArchivePackagePhotoOutput {
  readonly photoId: string;
  readonly archived: true;
  /** True when the photo was already archived before this command ran (idempotent no-op). */
  readonly alreadyArchived: boolean;
  readonly reason: PackagePhotoArchiveReason;
  /** Whether the photo was matched to an order at archive time. */
  readonly wasMatched: boolean;
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export const ArchivePackagePhoto: Command<ArchivePackagePhotoInput, ArchivePackagePhotoOutput> = {
  name: "ArchivePackagePhoto",
  inputSchema,
  permission: PERMISSIONS.SHIP_ARCHIVE_PACKAGE_PHOTO,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<ArchivePackagePhotoOutput>> {
    // 1. Load the row (RLS scopes to org).
    const photo = await tx.packagePhoto.findFirst({
      where: { id: input.photoId, organizationId: ctx.organizationId },
      select: {
        id: true,
        matched: true,
        archivedAt: true,
        archiveReason: true,
      },
    });
    if (photo === null) {
      throw new errors.NotFoundError({
        code: PACKAGE_PHOTO_ARCHIVE_NOT_FOUND,
        message:
          "PackagePhoto not found in the active tenancy. The id may be stale or belong to another organization.",
      });
    }

    // 2. Already archived → idempotent no-op. Preserve the original
    //    disposition (reason + actor + timestamp); emit no new
    //    outbox event. Audit-only so repeated operator clicks are
    //    still traceable without re-stamping the anchor.
    if (photo.archivedAt !== null) {
      const existingReason = (photo.archiveReason ?? input.reason) as PackagePhotoArchiveReason;
      return {
        output: {
          photoId: photo.id,
          archived: true,
          alreadyArchived: true,
          reason: existingReason,
          wasMatched: photo.matched,
        },
        audit: {
          action: "shipping.package_photo.archive_noop",
          resourceType: "PackagePhoto",
          resourceId: photo.id,
          metadata: {
            photoId: photo.id,
            alreadyArchived: true,
            existingReason,
            commandLogId,
          },
        },
        outboxEvents: [],
      };
    }

    // 3. Race-safe archive. `archivedAt: null` in the WHERE makes a
    //    concurrent double-archive converge — only one updateMany
    //    sets count=1; the loser re-reads and reports alreadyArchived.
    const now = clock.now();
    const result = await tx.packagePhoto.updateMany({
      where: { id: photo.id, organizationId: ctx.organizationId, archivedAt: null },
      data: {
        archivedAt: now,
        archiveReason: input.reason,
        archivedByUserId: ctx.actor.userId,
      },
    });

    if (result.count !== 1) {
      // Lost the race. Someone archived it between our read and
      // write — that's a benign convergence for an idempotent
      // disposition, not a conflict. Re-read the winner's reason.
      const winner = await tx.packagePhoto.findFirst({
        where: { id: photo.id, organizationId: ctx.organizationId },
        select: { archiveReason: true, matched: true },
      });
      return {
        output: {
          photoId: photo.id,
          archived: true,
          alreadyArchived: true,
          reason: (winner?.archiveReason ?? input.reason) as PackagePhotoArchiveReason,
          wasMatched: winner?.matched ?? photo.matched,
        },
        audit: {
          action: "shipping.package_photo.archive_noop",
          resourceType: "PackagePhoto",
          resourceId: photo.id,
          metadata: {
            photoId: photo.id,
            alreadyArchived: true,
            lostRace: true,
            commandLogId,
          },
        },
        outboxEvents: [],
      };
    }

    return {
      output: {
        photoId: photo.id,
        archived: true,
        alreadyArchived: false,
        reason: input.reason,
        wasMatched: photo.matched,
      },
      audit: {
        action: "shipping.package_photo.archived",
        resourceType: "PackagePhoto",
        resourceId: photo.id,
        metadata: {
          photoId: photo.id,
          reason: input.reason,
          wasMatched: photo.matched,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "shipping.package_photo.archived.v1",
          aggregateType: "PackagePhoto",
          aggregateId: photo.id,
          payload: {
            organizationId: ctx.organizationId,
            photoId: photo.id,
            reason: input.reason,
            wasMatched: photo.matched,
            archivedAt: now.toISOString(),
            archivedByUserId: ctx.actor.userId,
          },
        },
      ],
    };
  },
};
