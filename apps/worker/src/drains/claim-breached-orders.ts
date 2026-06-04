// Cross-tenant claim of orders that have blown their SLA deadline.
//
// Selection rules (all AND):
//   - `slaDeadlineAt < NOW()` — the order is past its end-to-end
//     SLA budget. (NULL deadlines — pre-SLA-wiring orders — are
//     excluded by the `<` comparison.)
//   - `currentStatus NOT IN ('SHIPPED','CANCELLED')` — terminal
//     orders are done; escalating them is meaningless.
//   - the order is NOT already in its org's EMERGENCY bucket
//     (LEFT JOIN / IS NULL). This is what keeps an escalated
//     order from being re-claimed every tick forever — once
//     `EscalateOrderForSlaBreach` moves it into EMERGENCY it drops
//     out of this result set.
//
// `FOR UPDATE OF o SKIP LOCKED` lets multiple worker replicas
// claim disjoint batches and reduces the window in which two ticks
// grab the same row. It is NOT the correctness guard, though: the
// dispatcher keys each escalation on
// `sla-escalate:{orderId}:{deadlineMs}`, so even if two workers
// claim the same order the command bus dedupes the second.
//
// Cross-tenant scope: runs in system context, reads across orgs in
// one SQL pass; the dispatcher then loops per-row to enter tenancy
// and call the bus. Legitimate system-context bridge (eslint
// Override 3b).

import type { PrismaClient } from "@pharmax/database";

export interface BreachedOrderRow {
  readonly id: string;
  readonly organizationId: string;
  readonly currentStatus: string;
  readonly slaDeadlineAt: Date;
}

export interface ClaimBreachedOrdersOptions {
  readonly batchSize: number;
}

export type BreachedOrderClaimClient = Pick<PrismaClient, "$queryRaw">;

interface RawRow {
  id: string;
  organizationId: string;
  currentStatus: string;
  slaDeadlineAt: Date;
}

export async function claimBreachedOrders(
  client: BreachedOrderClaimClient,
  options: ClaimBreachedOrdersOptions
): Promise<BreachedOrderRow[]> {
  const { batchSize } = options;

  const rows = await client.$queryRaw<RawRow[]>`
    SELECT
      o.id,
      o."organizationId",
      o."currentStatus"::text AS "currentStatus",
      o."slaDeadlineAt"
    FROM "order" AS o
    LEFT JOIN "bucket" AS b
      ON b.id = o."currentBucketId"
      AND b.code = 'EMERGENCY'
    WHERE o."slaDeadlineAt" < NOW()
      AND o."currentStatus" NOT IN ('SHIPPED', 'CANCELLED')
      AND b.id IS NULL
    ORDER BY o."slaDeadlineAt" ASC
    LIMIT ${batchSize}
    FOR UPDATE OF o SKIP LOCKED
  `;

  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      organizationId: row.organizationId,
      currentStatus: row.currentStatus,
      slaDeadlineAt: row.slaDeadlineAt,
    })
  );
}
