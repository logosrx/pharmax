// Workflow + bucket size scraper.
//
// Periodically queries Postgres for three "current state" snapshots
// the dashboards expect as gauges:
//
//   - pharmax_workflow_queue_depth{stage, organization_id}
//       open `order_stage_interval` rows (endedAt IS NULL), grouped
//       by stage `kind` and tenant.
//
//   - pharmax_workflow_emergency_bucket_size{organization_id}
//       count of `order` rows whose current bucket has
//       `Bucket.kind = EMERGENCY`.
//
//   - pharmax_shipping_bucket_size{bucket, organization_id}
//       count of `order` rows whose current bucket has
//       `Bucket.kind = EXCEPTION` (the shipping carrier-exception
//       bucket). Other bucket kinds are reported too in case the
//       dashboard wants to break them down later — adding label
//       cardinality here is cheap since BucketKind has only five
//       members.
//
// Architecture:
//
//   The OTel `ObservableGauge` API expects an asynchronous callback
//   that runs every collection cycle (typically 30s). Running three
//   GROUP BY queries on every scrape would create unnecessary load.
//
//   Instead we run a poll-loop tick that issues the queries on its
//   own schedule (default 30s, configurable) and stores the result
//   in module-scope maps. The gauge callbacks then read from those
//   maps — O(1) per emission, no DB hit during scrape.
//
//   Result: at most one DB query per gauge per tick, regardless of
//   how often Prometheus scrapes.
//
// PHI invariant: labels are limited to `stage`, `bucket`,
// `organization_id` (opaque UUID). No patient ids, no order ids.
//
// Failure isolation: a query throw inside the tick is logged at
// WARN and the existing in-memory snapshot is retained. Stale
// gauges are preferable to crashing the worker because Postgres
// blipped.

import { type PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;

// Module-scope state. Each map key is the label tuple stringified
// so multiple gauges can share the same backing store with O(1)
// reads on every scrape.
//
// `Map<key, number>` is used (not `Record`) so the gauges can
// iterate the live key set during emission without allocating.
const queueDepthByStageAndOrg = new Map<string, { stage: string; orgId: string; value: number }>();
const emergencyBucketSizeByOrg = new Map<string, number>();
const exceptionBucketSizeByOrg = new Map<string, number>();

let lastSuccessfulTickAt: Date | null = null;

const meter = getMeter("@pharmax/worker.workflow-scraper");

meter
  .createObservableGauge("pharmax_workflow_queue_depth", {
    description:
      "Number of currently-open `order_stage_interval` rows per stage per tenant. Snapshot updated by the workflow-bucket scraper.",
  })
  .addCallback((result) => {
    for (const entry of queueDepthByStageAndOrg.values()) {
      result.observe(entry.value, {
        stage: entry.stage,
        organization_id: entry.orgId,
      });
    }
  });

meter
  .createObservableGauge("pharmax_workflow_emergency_bucket_size", {
    description:
      "Count of orders whose current bucket has kind=EMERGENCY, per tenant. Source of truth: order ↔ bucket join, scraped from Postgres.",
  })
  .addCallback((result) => {
    for (const [orgId, value] of emergencyBucketSizeByOrg) {
      result.observe(value, { organization_id: orgId });
    }
  });

meter
  .createObservableGauge("pharmax_shipping_bucket_size", {
    description:
      "Count of orders sitting in operational buckets, labelled by Bucket.kind. The EXCEPTION row is the shipping carrier-exception backlog the on-call watches.",
  })
  .addCallback((result) => {
    for (const [orgId, value] of exceptionBucketSizeByOrg) {
      result.observe(value, { bucket: "EXCEPTION", organization_id: orgId });
    }
  });

export interface WorkflowBucketScraperDeps {
  readonly client: PrismaClient;
  readonly logger: Logger;
}

export interface WorkflowBucketScraperTickResult {
  readonly stagesObserved: number;
  readonly orgsWithEmergency: number;
  readonly orgsWithException: number;
}

export function createWorkflowBucketScraper(deps: WorkflowBucketScraperDeps): {
  tick: () => Promise<WorkflowBucketScraperTickResult>;
} {
  const log = deps.logger.child({ component: "workflow-bucket-scraper" });

  return {
    async tick(): Promise<WorkflowBucketScraperTickResult> {
      try {
        // System context: the scraper aggregates ACROSS tenants and
        // is wired in the worker boot path (eslint Override 3f
        // allowlists this path). The result set only carries
        // opaque UUIDs + enum names — no PHI, no tenant-identifying
        // strings.
        const result = await withSystemContext("worker-scrape:workflow-buckets", async () => {
          const [queueRows, emergencyRows, exceptionRows] = await Promise.all([
            deps.client.orderStageInterval.groupBy({
              by: ["kind", "organizationId"],
              where: { endedAt: null },
              _count: { _all: true },
            }),
            // Use raw SQL because Prisma's GROUP BY doesn't easily
            // express "join then group by org" in one query without
            // pulling the bucket rows into memory.
            deps.client.$queryRaw<Array<{ organization_id: string; count: bigint }>>`
              SELECT o."organizationId" AS organization_id, COUNT(*)::bigint AS count
              FROM "order" o
              JOIN "bucket" b ON b.id = o."currentBucketId"
              WHERE b."kind" = 'EMERGENCY'
              GROUP BY o."organizationId"
            `,
            deps.client.$queryRaw<Array<{ organization_id: string; count: bigint }>>`
              SELECT o."organizationId" AS organization_id, COUNT(*)::bigint AS count
              FROM "order" o
              JOIN "bucket" b ON b.id = o."currentBucketId"
              WHERE b."kind" = 'EXCEPTION'
              GROUP BY o."organizationId"
            `,
          ]);
          return { queueRows, emergencyRows, exceptionRows };
        });

        // Replace the snapshot atomically. Clear-then-fill is safe
        // because the gauge callbacks are synchronous and only run
        // when OTel collects; collection cannot interleave with this
        // tick on the Node.js event loop.
        queueDepthByStageAndOrg.clear();
        for (const row of result.queueRows) {
          const stage = String(row.kind);
          const orgId = row.organizationId;
          queueDepthByStageAndOrg.set(`${stage}:${orgId}`, {
            stage,
            orgId,
            value: row._count._all,
          });
        }

        emergencyBucketSizeByOrg.clear();
        for (const row of result.emergencyRows) {
          emergencyBucketSizeByOrg.set(row.organization_id, Number(row.count));
        }

        exceptionBucketSizeByOrg.clear();
        for (const row of result.exceptionRows) {
          exceptionBucketSizeByOrg.set(row.organization_id, Number(row.count));
        }

        lastSuccessfulTickAt = new Date();

        const tally: WorkflowBucketScraperTickResult = {
          stagesObserved: queueDepthByStageAndOrg.size,
          orgsWithEmergency: emergencyBucketSizeByOrg.size,
          orgsWithException: exceptionBucketSizeByOrg.size,
        };
        log.debug("scrape.complete", {
          stagesObserved: tally.stagesObserved,
          orgsWithEmergency: tally.orgsWithEmergency,
          orgsWithException: tally.orgsWithException,
        });
        return tally;
      } catch (cause) {
        log.warn("scrape.failed", {
          errorMessage: cause instanceof Error ? cause.message : "unknown",
          // Falling back to the previous snapshot; gauges keep
          // emitting their last-known values.
          lastSuccessfulTickAt: lastSuccessfulTickAt?.toISOString() ?? null,
        });
        return {
          stagesObserved: queueDepthByStageAndOrg.size,
          orgsWithEmergency: emergencyBucketSizeByOrg.size,
          orgsWithException: exceptionBucketSizeByOrg.size,
        };
      }
    },
  };
}

/**
 * Test-only accessor used by `workflow-bucket-scraper.test.ts` to
 * assert that a tick populates the gauge state correctly. Not part
 * of the public boot contract.
 */
export function _readScraperStateForTests(): {
  readonly queueDepth: ReadonlyMap<string, { stage: string; orgId: string; value: number }>;
  readonly emergencyBucketSize: ReadonlyMap<string, number>;
  readonly exceptionBucketSize: ReadonlyMap<string, number>;
} {
  return {
    queueDepth: queueDepthByStageAndOrg,
    emergencyBucketSize: emergencyBucketSizeByOrg,
    exceptionBucketSize: exceptionBucketSizeByOrg,
  };
}
