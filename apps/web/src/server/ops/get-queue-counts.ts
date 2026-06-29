// get-queue-counts — cheap per-bucket order counts for nav badges
// and the dashboard.
//
// Unlike `listOrdersInBucketByCode` (which hydrates up to 500 rows),
// this issues an indexed `COUNT(*)` per bucket inside ONE tenant
// transaction — so the shell can show live queue depth on every
// render without paying to materialize queue rows.
//
// PHI: counts only; no row data leaves the database.

import "server-only";

import { readInOrgScope, type TenantTransactionClient } from "@pharmax/database";

export type QueueCounts = Readonly<Record<string, number | null>>;

/**
 * Returns a map of `bucketCode → count` (null when the bucket isn't
 * provisioned for the org). One BEGIN/GUC/COMMIT for the whole batch.
 */
export async function getQueueCounts(input: {
  readonly organizationId: string;
  readonly bucketCodes: ReadonlyArray<string>;
}): Promise<QueueCounts> {
  if (input.bucketCodes.length === 0) return Object.freeze({});

  return readInOrgScope(input.organizationId, async (tx: TenantTransactionClient) => {
    const buckets = await tx.bucket.findMany({
      where: { organizationId: input.organizationId, code: { in: [...input.bucketCodes] } },
      select: { id: true, code: true },
    });
    const idByCode = new Map(buckets.map((b) => [b.code, b.id]));

    const out: Record<string, number | null> = {};
    for (const code of input.bucketCodes) {
      const bucketId = idByCode.get(code);
      if (bucketId === undefined) {
        out[code] = null;
        continue;
      }
      out[code] = await tx.order.count({
        where: { organizationId: input.organizationId, currentBucketId: bucketId },
      });
    }
    return Object.freeze(out);
  });
}
