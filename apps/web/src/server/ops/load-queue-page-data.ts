// Everything one queue page render needs, in as few transactions as
// possible.
//
// WHY THIS EXISTS. Adding identity to the queue cards gave each render
// three independent `readInOrgScope` calls — the bucket listing, the
// row enrichment, and the filter options — where it previously had one.
// Three concurrent transactions per render, on pages that a dispensing
// run reloads constantly. `list-shipping-queue.ts` already records what
// that costs: concurrency there once tripled the connection pressure for
// a single page, and `loadShippingQueuePageData` is the shape that fixed
// it. This is the same fix for the workflow queues.
//
// TWO PHASES, NOT ONE. The obvious version wraps all three reads in one
// scope. That would be wrong: `attachQueueRowDetails` decrypts patient
// names and dispatches `ViewPatient` audit writes, and holding a read
// transaction open across KMS round trips and command dispatches is
// exactly what the two-phase discipline in `get-patient-detail.ts`
// exists to prevent — it would pin a pooled connection for the duration
// of the slowest thing on the page.
//
// So: phase one shares ONE transaction for the two pure reads and
// closes it. Phase two enriches, opening its own short read before
// decrypting and auditing outside any transaction. Two scopes, neither
// held across the slow part, down from three held concurrently.
//
// PHI: the returned rows carry decrypted patient names. See
// `attach-queue-row-details.ts` for the audit and masking contract.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

import {
  attachQueueRowDetails,
  type AttachQueueRowDetailsResult,
} from "./attach-queue-row-details.js";
import {
  listOrdersInBucketByCode,
  type BucketOrderRow,
  type ListBucketResult,
  type QueueFilters,
} from "./list-orders-in-bucket.js";
import { loadQueueFilterOptions, type QueueFilterOptions } from "./load-queue-filter-options.js";

export interface QueuePageData {
  readonly queue: ListBucketResult;
  readonly filterOptions: QueueFilterOptions;
  readonly detailed: AttachQueueRowDetailsResult<BucketOrderRow>;
}

export async function loadQueuePageData(input: {
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly bucketCode: string;
  readonly filters?: QueueFilters;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<QueuePageData> {
  // Phase one — both pure reads on one connection, sequentially (a
  // Prisma interactive transaction serializes queries on its single
  // connection anyway, so there is nothing to gain from concurrency and
  // a shared client makes it unsafe).
  const { queue, filterOptions } = await readInOrgScope(input.organizationId, async (tx) => {
    const q = await listOrdersInBucketByCode({
      organizationId: input.organizationId,
      bucketCode: input.bucketCode,
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      tx,
    });
    const options = await loadQueueFilterOptions({
      organizationId: input.organizationId,
      ...(input.filters?.clinicId === undefined
        ? {}
        : { selectedClinicId: input.filters.clinicId }),
      tx,
    });
    return { queue: q, filterOptions: options };
  });

  // Phase two — outside the transaction above, because this decrypts
  // and audits. Only the visible page is enriched.
  const detailed = await attachQueueRowDetails({
    organizationId: input.organizationId,
    operatorUserId: input.operatorUserId,
    rows: queue.rows,
  });

  return Object.freeze({ queue, filterOptions, detailed });
}

export interface MultiBucketQueuePageData {
  readonly buckets: Readonly<Record<string, ListBucketResult>>;
  readonly filterOptions: QueueFilterOptions;
  readonly detailed: AttachQueueRowDetailsResult<BucketOrderRow>;
}

/**
 * The typing queue's shape: two buckets on one page, enriched together
 * so a patient with an order in each is decrypted and audited once.
 */
export async function loadMultiBucketQueuePageData(input: {
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly bucketCodes: ReadonlyArray<string>;
  readonly filters?: QueueFilters;
  /** Cursors keyed by bucket code — paging one list must not reset the other. */
  readonly cursors?: Readonly<Record<string, string | undefined>>;
  readonly limit?: number;
}): Promise<MultiBucketQueuePageData> {
  const { buckets, filterOptions } = await readInOrgScope(input.organizationId, async (tx) => {
    const out: Record<string, ListBucketResult> = {};
    for (const bucketCode of input.bucketCodes) {
      const cursor = input.cursors?.[bucketCode];
      out[bucketCode] = await listOrdersInBucketByCode({
        organizationId: input.organizationId,
        bucketCode,
        ...(input.filters !== undefined ? { filters: input.filters } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        tx,
      });
    }
    const options = await loadQueueFilterOptions({
      organizationId: input.organizationId,
      ...(input.filters?.clinicId === undefined
        ? {}
        : { selectedClinicId: input.filters.clinicId }),
      tx,
    });
    return { buckets: Object.freeze(out), filterOptions: options };
  });

  const detailed = await attachQueueRowDetails({
    organizationId: input.organizationId,
    operatorUserId: input.operatorUserId,
    rows: input.bucketCodes.flatMap((code) => buckets[code]?.rows ?? []),
  });

  return Object.freeze({ buckets, filterOptions, detailed });
}
