// Expired package-photo upload-token reaper.
//
// `package_photo_upload_token` rows are the choke-point claim the
// S3 storage adapter writes during `beginUpload` and the
// `CapturePackagePhoto` command reads during dispatch. The row's
// `expiresAt` (issuedAt + 1h by default) gates `resolveUploadToken`
// — past expiry the resolver returns null regardless of whether the
// row still exists. So once a row is expired it is pure dead weight:
//
//   - Consumed-then-expired: the capture already copied the storage
//     tuple onto the durable `package_photo` row. The token row is
//     no longer referenced by anything.
//   - Abandoned: the upload happened but the dispatch never did
//     (the rep closed the tab, lost connectivity, etc.). The token
//     row is unreferenced and the resolver already refuses it.
//
// Either way the row can be deleted. Without this sweep the table
// grows by one row per dock capture forever.
//
// Design rules (mirror `reap-stuck-npi-sync-runs.ts`):
//
//   1. Cross-tenant. Runs in system context and sweeps every org's
//      expired rows in one pass. There are no side effects beyond
//      the delete — no audit_log / event_outbox / command_log. The
//      token row is infrastructure, not a domain aggregate.
//
//   2. Batched. We select up to `batchSize` expired token ids, then
//      `deleteMany` by id. Bounding each tick keeps a first-run
//      backlog (the table was never swept before this reaper
//      shipped) from issuing one enormous DELETE; the poll loop
//      catches up over successive ticks.
//
//   3. Idempotent at the row level: a deleted row is gone, so the
//      `expiresAt <= now` predicate naturally excludes it from
//      future sweeps. The predicate IS the idempotency guard, and
//      concurrent reapers (multi-pod) converge — a row deleted by
//      one pod simply isn't returned to another.
//
//   4. Cutoff = `now`, matching the resolver's own
//      `expiresAt <= now` gate exactly. No grace margin is needed:
//      if the reaper considers a row expired, `resolveUploadToken`
//      already does too, so deleting it changes no in-flight
//      capture's outcome.
//
// SCOPE: this reaper reclaims the DB ROWS only. The S3 OBJECTS the
// abandoned tokens point at (`org/{org}/photo/upload/{token}` with
// no corresponding `package_photo`) are orphaned bytes reclaimed by
// a separate sweep — that one needs LIST + DELETE on the storage
// port and a conservative safety window, and is tracked as
// follow-up work. Deleting the token row here does NOT delete any
// S3 object, so a captured photo's bytes (referenced by
// `package_photo.storageKey`) are never at risk from this reaper.

import type { PrismaClient } from "@pharmax/database";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

export interface ReapExpiredPackagePhotoUploadTokensDeps {
  readonly client: Pick<PrismaClient, "packagePhotoUploadToken">;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface ReapExpiredPackagePhotoUploadTokensOptions {
  /**
   * Maximum rows to delete per tick. Bounds the worst-case DELETE
   * (notably the first run after this reaper ships, when the table
   * may hold a backlog of never-swept rows). The poll loop drains
   * the remainder on subsequent ticks.
   */
  readonly batchSize: number;
}

export interface ReapExpiredPackagePhotoUploadTokensResult {
  readonly sweptCount: number;
}

export interface ExpiredPackagePhotoUploadTokenReaper {
  tick(): Promise<ReapExpiredPackagePhotoUploadTokensResult>;
}

export function createExpiredPackagePhotoUploadTokenReaper(
  deps: ReapExpiredPackagePhotoUploadTokensDeps,
  options: ReapExpiredPackagePhotoUploadTokensOptions
): ExpiredPackagePhotoUploadTokenReaper {
  const log = deps.logger.child({ component: "package-photo-token-reaper" });

  return {
    async tick(): Promise<ReapExpiredPackagePhotoUploadTokensResult> {
      const now = deps.clock.now();

      const sweptCount = await withSystemContext(
        "worker:package-photo-token-reaper:sweep",
        async () => {
          // Select a bounded batch of expired token ids first, then
          // delete by primary key. `deleteMany` has no LIMIT, so the
          // id-select is how we cap each tick.
          const expired = await deps.client.packagePhotoUploadToken.findMany({
            where: { expiresAt: { lte: now } },
            select: { token: true },
            take: options.batchSize,
          });
          if (expired.length === 0) return 0;

          const result = await deps.client.packagePhotoUploadToken.deleteMany({
            where: { token: { in: expired.map((row) => row.token) } },
          });
          return result.count;
        }
      );

      if (sweptCount > 0) {
        log.info("package-photo-token-reaper.swept", {
          event: "package-photo-token-reaper.swept",
          sweptCount,
          batchSize: options.batchSize,
          cutoff: now.toISOString(),
        });
      }

      return Object.freeze({ sweptCount });
    },
  };
}
