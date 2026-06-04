// Orphan package-photo S3 object sweeper (janitor, part 2).
//
// The upload-token reaper (`reap-expired-package-photo-upload-tokens.ts`)
// reclaims the ephemeral DB rows. This sweeper reclaims the S3
// OBJECTS those rows pointed at when no durable `package_photo` ever
// adopted them. Two orphan classes:
//
//   (a) token-expired-without-capture — the rep uploaded bytes
//       (PUT succeeded, token row written) but never dispatched the
//       capture, so no `package_photo` references the key. The token
//       row is swept by the reaper; the object is left dangling.
//
//   (b) insert-failed orphan — the S3 adapter's PUT succeeded but
//       the token-row INSERT failed, so no token row ever existed
//       and no capture could have happened. Only an S3 LIST finds
//       these.
//
// Both reduce to the SAME predicate once enough time passes:
//
//   An object under `org/{org}/photo/upload/...` older than the
//   safety window is an orphan IFF no `package_photo.storageKey`
//   equals its key.
//
// Why no token-table join: the safety window (default 24h) is far
// larger than the upload-token TTL (1h). Any object older than the
// window whose capture succeeded already has a `package_photo` row;
// any without one had its token expire ~23h ago and will never be
// captured. So `package_photo` membership + age is sufficient — the
// token table adds nothing at that age.
//
// Safety:
//
//   - Conservative age gate. We NEVER consider an object younger
//     than `safetyWindowMs`. This eliminates the PUT-then-INSERT
//     race (object exists, token row not yet written) and the
//     upload→dispatch gap (token valid, capture imminent) as
//     false positives — those windows are seconds-to-an-hour; 24h
//     is orders of magnitude beyond them.
//
//   - Exact-key reference check. We match `package_photo.storageKey`
//     by exact key equality (`IN (candidateKeys)`), in system
//     context (cross-org — the sweep spans every tenant's prefix).
//     The S3 adapter writes `package_photo.storageKey` = the exact
//     S3 key, so a captured photo always matches and is never
//     deleted.
//
// Pagination:
//
//   - The sweeper holds an in-memory continuation cursor across
//     ticks. Each tick lists one bounded page (≤ maxKeysPerTick),
//     processes it, and advances the cursor; when the LIST is
//     exhausted the cursor resets and the next tick restarts from
//     the top. In-memory state is fine: on restart the scan simply
//     begins again from the top, and the operation is idempotent
//     (deleting an already-deleted key is a no-op). No on-disk
//     cursor to manage.
//
// IAM: the worker task role needs `s3:ListBucket` +
// `s3:DeleteObject` on the package-photos bucket (a superset of the
// web tier's get/put). Tracked in the Terraform slice.

import type { PrismaClient } from "@pharmax/database";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

/**
 * Narrow S3 surface the sweeper needs. The worker composition root
 * adapts a real `@aws-sdk/client-s3` `S3Client` to this port at boot
 * (dynamic import, ListObjectsV2 + DeleteObjects). Mirrors the
 * report-archive surface pattern — the drain stays SDK-free and
 * testable against a fake.
 */
export interface PackagePhotoObjectStore {
  listObjects(input: {
    readonly prefix: string;
    readonly continuationToken: string | undefined;
    readonly maxKeys: number;
  }): Promise<PackagePhotoObjectPage>;
  deleteObjects(input: { readonly keys: ReadonlyArray<string> }): Promise<{ deletedCount: number }>;
}

export interface PackagePhotoObjectPage {
  readonly objects: ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>;
  /** Undefined when the listing is exhausted (no more pages). */
  readonly nextContinuationToken: string | undefined;
}

export interface SweepOrphanPackagePhotoObjectsDeps {
  readonly store: PackagePhotoObjectStore;
  readonly prisma: Pick<PrismaClient, "packagePhoto">;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface SweepOrphanPackagePhotoObjectsOptions {
  /**
   * Minimum object age before it can be considered an orphan.
   * MUST be comfortably larger than the upload-token TTL (1h) so
   * the upload→dispatch gap and the PUT-then-INSERT race can never
   * be mistaken for an orphan. Default 24h.
   */
  readonly safetyWindowMs: number;
  /** Max S3 keys to list (and therefore process) per tick. */
  readonly maxKeysPerTick: number;
}

export interface SweepOrphanPackagePhotoObjectsResult {
  /** Objects listed this tick (before any filtering). */
  readonly scanned: number;
  /** Orphan objects deleted this tick. */
  readonly deletedCount: number;
}

export interface OrphanPackagePhotoObjectSweeper {
  tick(): Promise<SweepOrphanPackagePhotoObjectsResult>;
}

// All package-photo keys are `org/{orgId}/photo/...`; the upload
// objects specifically are `org/{orgId}/photo/upload/{token}`. List
// under `org/` and filter to the upload segment so a future
// non-upload prefix in the same bucket is never touched.
const LIST_PREFIX = "org/";
const UPLOAD_KEY_SEGMENT = "/photo/upload/";

export function createOrphanPackagePhotoObjectSweeper(
  deps: SweepOrphanPackagePhotoObjectsDeps,
  options: SweepOrphanPackagePhotoObjectsOptions
): OrphanPackagePhotoObjectSweeper {
  const log = deps.logger.child({ component: "package-photo-orphan-sweeper" });

  // In-memory pagination cursor. Advances across ticks; resets to
  // undefined (restart from the top) when the listing is exhausted.
  let continuationToken: string | undefined = undefined;

  return {
    async tick(): Promise<SweepOrphanPackagePhotoObjectsResult> {
      const now = deps.clock.now();

      const page = await deps.store.listObjects({
        prefix: LIST_PREFIX,
        continuationToken,
        maxKeys: options.maxKeysPerTick,
      });
      // Advance (or reset) the cursor for the next tick BEFORE any
      // early return, so a page of all-recent / all-referenced
      // objects still makes forward progress.
      continuationToken = page.nextContinuationToken;

      const cutoffMs = now.getTime() - options.safetyWindowMs;
      const candidateKeys = page.objects
        .filter((o) => o.key.includes(UPLOAD_KEY_SEGMENT) && o.lastModified.getTime() < cutoffMs)
        .map((o) => o.key);

      if (candidateKeys.length === 0) {
        return Object.freeze({ scanned: page.objects.length, deletedCount: 0 });
      }

      // Cross-org exact-key reference check in system context. Any
      // candidate NOT backing a `package_photo` row is an orphan.
      const referenced = await withSystemContext(
        "worker:package-photo-orphan-sweeper:reference-check",
        () =>
          deps.prisma.packagePhoto.findMany({
            where: { storageKey: { in: candidateKeys } },
            select: { storageKey: true },
          })
      );
      const referencedKeys = new Set(referenced.map((r) => r.storageKey));
      const orphanKeys = candidateKeys.filter((key) => !referencedKeys.has(key));

      if (orphanKeys.length === 0) {
        return Object.freeze({ scanned: page.objects.length, deletedCount: 0 });
      }

      const deleted = await deps.store.deleteObjects({ keys: orphanKeys });

      // warn (not info): an orphan always implies a prior abandoned
      // upload or a failed token INSERT. Routine, but worth seeing
      // the rate of in the logs.
      log.warn("package-photo-orphan-sweeper.swept", {
        event: "package-photo-orphan-sweeper.swept",
        scanned: page.objects.length,
        candidateCount: candidateKeys.length,
        orphanCount: orphanKeys.length,
        deletedCount: deleted.deletedCount,
        safetyWindowMs: options.safetyWindowMs,
      });

      return Object.freeze({ scanned: page.objects.length, deletedCount: deleted.deletedCount });
    },
  };
}
