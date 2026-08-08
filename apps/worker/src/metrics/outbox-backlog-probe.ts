// Outbox backlog probe — the app-emitted half of the outbox alarms.
//
// A stuck event outbox is the quietest failure this platform can
// have: commands keep committing, pharmacists keep working, and
// every side effect — shipping notifications, billing
// materialization, webhook fan-out, evidence publishing — silently
// stops. The ECS running-count alarm catches a DEAD WORKER; nothing
// until now caught a live worker whose drainer stopped making
// progress (poison row, lock pile-up, handler wedged on a
// downstream).
//
// Each tick runs ONE aggregate over `event_outbox` and reports:
//
//   OutboxUndispatchedDepth        rows in PENDING or FAILED — work
//                                  the drainer still owes, including
//                                  rows mid-lease and rows waiting
//                                  out retry backoff.
//   OutboxOldestUndispatchedAge    seconds since `createdAt` of the
//                                  oldest such row; 0 when none. THE
//                                  alarm signal: if the drainer is
//                                  healthy this cannot grow past one
//                                  retry ladder (~2h worst case for a
//                                  row dying), and 15 sustained
//                                  minutes already means some side
//                                  effect is 15 minutes late.
//   OutboxDeadDepth                rows marked DEAD — side effects
//                                  permanently missed until an admin
//                                  replay. Non-zero is actionable
//                                  every time.
//
// Age is measured over PENDING+FAILED regardless of lease state, on
// purpose: a leased row is invisible to `claimOutboxEvents`, but it
// is still an undelivered side effect, and a handler that holds a
// lease forever is one of the stalls this probe exists to see.
//
// The numbers go two places, deliberately in this order:
//   1. A structured `outbox.backlog.probe` log line — dev/test
//      evidence, and the operator's grep target during an incident.
//   2. CloudWatch via the metrics publisher — what the Terraform
//      alarms in `modules/cloudwatch` evaluate.
//
// Failure posture: a query or publish throw is caught, logged at
// WARN, and the tick ends. Missing datapoints are the signal a
// broken probe leaves behind, and the warning-tier age alarm treats
// missing data as breaching — so a probe that stops publishing
// becomes an alarm, not a blind spot.

import type { PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import type { WorkerMetricsPublisher } from "./metrics-publisher.js";

type Logger = loggerContract.Logger;

/**
 * Namespace for worker-emitted operational metrics. Mirrored by the
 * `worker_metric_namespace` Terraform variable in
 * `modules/cloudwatch` — change both together or the alarms watch
 * an empty namespace.
 */
export const WORKER_METRIC_NAMESPACE = "Pharmax/Worker";

export const OUTBOX_UNDISPATCHED_DEPTH_METRIC = "OutboxUndispatchedDepth";
export const OUTBOX_OLDEST_UNDISPATCHED_AGE_METRIC = "OutboxOldestUndispatchedAgeSeconds";
export const OUTBOX_DEAD_DEPTH_METRIC = "OutboxDeadDepth";

export interface OutboxBacklogSnapshot {
  readonly undispatchedDepth: number;
  readonly oldestUndispatchedAgeSeconds: number;
  readonly deadDepth: number;
}

export interface OutboxBacklogProbeDeps {
  readonly client: Pick<PrismaClient, "$queryRaw">;
  readonly logger: Logger;
  readonly publisher: WorkerMetricsPublisher;
}

export interface OutboxBacklogProbeTickResult {
  /** Null when the tick failed (query or publish threw). */
  readonly snapshot: OutboxBacklogSnapshot | null;
}

interface BacklogRow {
  readonly undispatched_depth: bigint;
  readonly oldest_undispatched_age_seconds: number;
  readonly dead_depth: bigint;
}

export function createOutboxBacklogProbe(deps: OutboxBacklogProbeDeps): {
  tick: () => Promise<OutboxBacklogProbeTickResult>;
} {
  const log = deps.logger.child({ component: "outbox-backlog-probe" });

  return {
    async tick(): Promise<OutboxBacklogProbeTickResult> {
      try {
        // System context: `event_outbox` is a cross-tenant platform
        // ledger (same posture as the claim drain). The aggregate
        // carries counts and an age — no payloads, no PHI.
        const rows = await withSystemContext(
          "worker-probe:outbox-backlog",
          () =>
            deps.client.$queryRaw<BacklogRow[]>`
            SELECT
              COUNT(*) FILTER (WHERE "status" IN ('PENDING','FAILED'))::bigint
                AS undispatched_depth,
              COALESCE(EXTRACT(EPOCH FROM (
                NOW() - MIN("createdAt") FILTER (WHERE "status" IN ('PENDING','FAILED'))
              )), 0)::double precision
                AS oldest_undispatched_age_seconds,
              COUNT(*) FILTER (WHERE "status" = 'DEAD')::bigint
                AS dead_depth
            FROM "event_outbox"
          `
        );

        const row = rows[0];
        if (row === undefined) {
          throw new Error("outbox backlog aggregate returned no rows");
        }
        const snapshot: OutboxBacklogSnapshot = Object.freeze({
          undispatchedDepth: Number(row.undispatched_depth),
          // Clock skew between app and DB cannot produce a negative age
          // here because both sides of the subtraction are DB time.
          oldestUndispatchedAgeSeconds: Math.max(0, row.oldest_undispatched_age_seconds),
          deadDepth: Number(row.dead_depth),
        });

        log.info("outbox.backlog.probe", {
          undispatchedDepth: snapshot.undispatchedDepth,
          oldestUndispatchedAgeSeconds: snapshot.oldestUndispatchedAgeSeconds,
          deadDepth: snapshot.deadDepth,
        });

        await deps.publisher.publish(WORKER_METRIC_NAMESPACE, [
          {
            metricName: OUTBOX_UNDISPATCHED_DEPTH_METRIC,
            value: snapshot.undispatchedDepth,
            unit: "Count",
          },
          {
            metricName: OUTBOX_OLDEST_UNDISPATCHED_AGE_METRIC,
            value: snapshot.oldestUndispatchedAgeSeconds,
            unit: "Seconds",
          },
          {
            metricName: OUTBOX_DEAD_DEPTH_METRIC,
            value: snapshot.deadDepth,
            unit: "Count",
          },
        ]);

        return { snapshot };
      } catch (cause) {
        log.warn("outbox.backlog.probe.failed", {
          errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
          detail:
            "no datapoint published this tick; the warning-tier age alarm treats missing data as breaching, so a persistent probe failure raises the alarm itself",
        });
        return { snapshot: null };
      }
    },
  };
}
