// Generic queue-by-bucket projection for the operator console.
//
// Workflow stage pages (typing, PV1, fill, final, shipping) all
// share the same shape: list orders currently in a named bucket
// (resolved by `(organizationId, code)`) with a presentation
// projection that surfaces the operator-relevant fields (status,
// priority, age, current assignee).
//
// One projection serves every stage; per-page logic decides which
// actions to surface based on `currentStatus` + the operator's
// permissions.
//
// PHI: returns non-PHI columns only.

import "server-only";

import {
  readInOrgScope,
  type OrderPriority,
  type OrderStatus,
  type TenantTransactionClient,
} from "@pharmax/database";

export interface BucketOrderRow {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly currentStatus: OrderStatus;
  readonly priority: OrderPriority;
  readonly clinicId: string;
  readonly siteId: string;
  readonly receivedAt: Date;
  readonly enteredBucketAt: Date;
  readonly slaDeadlineAt: Date | null;
  /** Currently-claimed-by user id (when status is *_IN_PROGRESS). */
  readonly currentAssigneeUserId: string | null;
  readonly version: number;
}

export interface ListBucketResult {
  readonly bucketExists: boolean;
  readonly bucketId: string | null;
  readonly bucketName: string | null;
  readonly rows: ReadonlyArray<BucketOrderRow>;
}

export async function listOrdersInBucketByCode(input: {
  readonly organizationId: string;
  readonly bucketCode: string;
  readonly limit?: number;
  /**
   * Optional shared tenant-scoped transaction. Provide it to batch
   * this read into an outer `readInOrgScope(organizationId, ...)` so a
   * page that lists several buckets pays ONE BEGIN/GUC/COMMIT and holds
   * ONE connection instead of one per bucket. Omit it to open a
   * dedicated scope. When provided it MUST already be scoped to
   * `organizationId` (i.e. the outer `readInOrgScope` used the same org).
   */
  readonly tx?: TenantTransactionClient;
}): Promise<ListBucketResult> {
  const limit = Math.min(input.limit ?? 100, 500);

  const run = async (tx: TenantTransactionClient): Promise<ListBucketResult> => {
    const bucket = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: input.organizationId,
          code: input.bucketCode,
        },
      },
      select: { id: true, name: true },
    });
    if (bucket === null) {
      return Object.freeze({
        bucketExists: false,
        bucketId: null,
        bucketName: null,
        rows: [],
      });
    }

    const orders = await tx.order.findMany({
      where: {
        organizationId: input.organizationId,
        currentBucketId: bucket.id,
      },
      select: {
        id: true,
        externalOrderNumber: true,
        currentStatus: true,
        priority: true,
        clinicId: true,
        siteId: true,
        receivedAt: true,
        updatedAt: true,
        slaDeadlineAt: true,
        currentAssigneeUserId: true,
        version: true,
      },
      // Queue scanner shape — match the covering index:
      //   (organizationId, currentBucketId, currentStatus, priority,
      //    slaDeadlineAt, receivedAt)
      // Postgres serves this from one btree without a sort step.
      orderBy: [{ priority: "desc" }, { slaDeadlineAt: "asc" }, { receivedAt: "asc" }],
      take: limit,
    });

    return Object.freeze({
      bucketExists: true,
      bucketId: bucket.id,
      bucketName: bucket.name,
      rows: orders.map((o) =>
        Object.freeze({
          orderId: o.id,
          externalOrderNumber: o.externalOrderNumber,
          currentStatus: o.currentStatus,
          priority: o.priority,
          clinicId: o.clinicId,
          siteId: o.siteId,
          receivedAt: o.receivedAt,
          enteredBucketAt: o.updatedAt,
          slaDeadlineAt: o.slaDeadlineAt,
          currentAssigneeUserId: o.currentAssigneeUserId,
          version: o.version,
        })
      ),
    });
  };

  return input.tx !== undefined ? run(input.tx) : readInOrgScope(input.organizationId, run);
}

/**
 * Batch several bucket listings into ONE tenant-scoped transaction.
 *
 * The typing queue spans two buckets (INBOX + TYPING). Issuing them as
 * two independent `readInOrgScope` calls opened two transactions on two
 * pooled connections; under enterprise concurrency that doubles the
 * connection pressure per render for no benefit (the queries are fast
 * and indexed). This helper opens a SINGLE scope and runs the bucket
 * reads sequentially on the same connection — one BEGIN/GUC/COMMIT, one
 * connection held briefly.
 *
 * Returns a map keyed by bucket code, preserving the requested order so
 * callers can read `result[code]` directly.
 */
export async function listOrdersInBucketsByCode(input: {
  readonly organizationId: string;
  readonly bucketCodes: ReadonlyArray<string>;
  readonly limit?: number;
}): Promise<Readonly<Record<string, ListBucketResult>>> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const out: Record<string, ListBucketResult> = {};
    // Sequential (not Promise.all): a Prisma interactive-transaction
    // client runs one query at a time on its single connection, so
    // concurrent issue would be unsafe. Sequential awaits still pay
    // the BEGIN/GUC/COMMIT exactly once for the whole batch.
    for (const bucketCode of input.bucketCodes) {
      out[bucketCode] = await listOrdersInBucketByCode({
        organizationId: input.organizationId,
        bucketCode,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        tx,
      });
    }
    return Object.freeze(out);
  });
}
