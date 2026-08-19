// Operator telemetry pruner.
//
// `operator_presence_slot` and `operator_activity_event` are the only
// two tables in the platform written at operator-interaction rate.
// Presence is already compacted at the schema level — one row per
// operator per slot, so a client cannot choose how many rows it
// creates — but compaction bounds the WIDTH of the stream, not its
// length. Without a retention sweep both tables grow monotonically
// for as long as the pharmacy operates, and the first sign of it is
// a report timing out eighteen months from now.
//
// So the bound is two-part, and both parts are needed:
//
//   schema  — the slot unique key caps rows per operator per slot
//   here    — retention caps how far back rows are kept at all
//
// These rows are TELEMETRY, not audit evidence. `audit_log` is
// hash-chained, INSERT/SELECT-only, and kept for seven years because
// it answers "who touched PHI". These two answer "how busy was the
// floor last quarter", which stops being a question long before it
// stops being storage. Deleting them loses no compliance record —
// login stays in audit_log, commands stay in command_log, prints
// stay in print_job, and scan failures stay in command_log.errorCode.
//
// Design rules (mirroring `reap-expired-package-photo-upload-tokens`):
//
//   1. Cross-tenant. Runs in system context and sweeps every org in
//      one pass. No audit_log / event_outbox / command_log side
//      effects — retention of telemetry is not a domain event.
//
//   2. Batched per table. Select up to `batchSize` ids past the
//      cutoff, then delete by primary key. `deleteMany` has no
//      LIMIT, so the id-select is what caps each tick and keeps a
//      first-run backlog (both tables have never been swept before
//      this loop shipped) from issuing one enormous DELETE. The poll
//      loop drains the remainder over subsequent ticks.
//
//   3. Idempotent at the row level: a deleted row is gone, so the
//      cutoff predicate naturally excludes it next tick. Concurrent
//      pruners (multi-pod) converge — a row deleted by one pod is
//      simply not returned to another.

import type { PrismaClient } from "@pharmax/database";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

export interface PruneOperatorTelemetryDeps {
  readonly client: Pick<PrismaClient, "operatorPresenceSlot" | "operatorActivityEvent">;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface PruneOperatorTelemetryOptions {
  /**
   * How long telemetry is kept. Rows whose timestamp is strictly
   * older than `now - retentionDays` are removed.
   */
  readonly retentionDays: number;
  /** Maximum rows removed per table per tick. */
  readonly batchSize: number;
}

export interface PruneOperatorTelemetryResult {
  readonly presenceSlotsPruned: number;
  readonly activityEventsPruned: number;
  readonly cutoff: Date;
}

export interface OperatorTelemetryPruner {
  tick(): Promise<PruneOperatorTelemetryResult>;
}

const MS_PER_DAY = 24 * 60 * 60_000;

export function createOperatorTelemetryPruner(
  deps: PruneOperatorTelemetryDeps,
  options: PruneOperatorTelemetryOptions
): OperatorTelemetryPruner {
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
    throw new RangeError(
      `retentionDays must be a positive finite number (got ${options.retentionDays})`
    );
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new RangeError(`batchSize must be a positive integer (got ${options.batchSize})`);
  }

  const log = deps.logger.child({ component: "operator-telemetry-pruner" });

  return {
    async tick(): Promise<PruneOperatorTelemetryResult> {
      const now = deps.clock.now();
      const cutoff = new Date(now.getTime() - options.retentionDays * MS_PER_DAY);

      const { presenceSlotsPruned, activityEventsPruned } = await withSystemContext(
        "worker:operator-telemetry-pruner:sweep",
        async () => {
          // Presence slots age out on the slot they cover, not on the
          // last beat folded into them — the slot start is what the
          // index is ordered by and what the report windows on.
          const staleSlots = await deps.client.operatorPresenceSlot.findMany({
            where: { slotStartedAt: { lt: cutoff } },
            select: { id: true },
            take: options.batchSize,
          });
          const slotsPruned =
            staleSlots.length === 0
              ? 0
              : (
                  await deps.client.operatorPresenceSlot.deleteMany({
                    where: { id: { in: staleSlots.map((row) => row.id) } },
                  })
                ).count;

          const staleEvents = await deps.client.operatorActivityEvent.findMany({
            where: { occurredAt: { lt: cutoff } },
            select: { id: true },
            take: options.batchSize,
          });
          const eventsPruned =
            staleEvents.length === 0
              ? 0
              : (
                  await deps.client.operatorActivityEvent.deleteMany({
                    where: { id: { in: staleEvents.map((row) => row.id) } },
                  })
                ).count;

          return { presenceSlotsPruned: slotsPruned, activityEventsPruned: eventsPruned };
        }
      );

      if (presenceSlotsPruned > 0 || activityEventsPruned > 0) {
        log.info("operator-telemetry-pruner.swept", {
          event: "operator-telemetry-pruner.swept",
          presenceSlotsPruned,
          activityEventsPruned,
          retentionDays: options.retentionDays,
          batchSize: options.batchSize,
          cutoff: cutoff.toISOString(),
        });
      }

      return Object.freeze({ presenceSlotsPruned, activityEventsPruned, cutoff });
    },
  };
}
