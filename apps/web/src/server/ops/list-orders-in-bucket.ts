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
// PHI: returns non-PHI columns only. Patient identity is attached
// separately by `attachQueueRowDetails`, which owns the audit
// obligation that comes with it.
//
// PAGINATION IS A PHI CONTROL HERE, not just ergonomics. This read used
// to be an unpaginated `take: 100`, which was defensible while the row
// carried no patient identity. Now that a card shows a name, page size
// is what bounds KMS unwraps and `ViewPatient` audit writes per render,
// so the default is deliberately small and the ceiling is low.

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
  /** Opaque cursor for the next page, or null at the end. */
  readonly nextCursor: string | null;
  /** Rows in this bucket matching the filters, ignoring pagination. */
  readonly totalMatching: number;
}

/** Default page size. Small on purpose — see the header. */
export const QUEUE_PAGE_SIZE = 25;
/** Hard ceiling, even if a caller asks for more. */
export const QUEUE_MAX_PAGE_SIZE = 100;

export interface QueueFilters {
  /** Restrict to one client. */
  readonly clinicId?: string;
  /** Restrict to one pharmacy site. */
  readonly siteId?: string;
  /** Restrict to one priority band — how an operator finds the rush work. */
  readonly priority?: OrderPriority;
  /** Only rows already past their SLA deadline. */
  readonly breachedOnly?: boolean;
  /** Only rows nobody has claimed. */
  readonly unclaimedOnly?: boolean;
}

export async function listOrdersInBucketByCode(input: {
  readonly organizationId: string;
  readonly bucketCode: string;
  readonly limit?: number;
  /** Cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
  readonly filters?: QueueFilters;
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
  const limit = Math.min(input.limit ?? QUEUE_PAGE_SIZE, QUEUE_MAX_PAGE_SIZE);
  const filters = input.filters ?? {};

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
        nextCursor: null,
        totalMatching: 0,
      });
    }

    const where = {
      organizationId: input.organizationId,
      currentBucketId: bucket.id,
      ...(filters.clinicId === undefined ? {} : { clinicId: filters.clinicId }),
      ...(filters.siteId === undefined ? {} : { siteId: filters.siteId }),
      ...(filters.priority === undefined ? {} : { priority: filters.priority }),
      // `lt: now` rather than a stored flag: breach is a fact about a
      // deadline and the clock, so computing it in the predicate cannot
      // go stale. Rows with no deadline are not breached.
      ...(filters.breachedOnly === true ? { slaDeadlineAt: { lt: new Date() } } : {}),
      ...(filters.unclaimedOnly === true ? { currentAssigneeUserId: null } : {}),
    };

    // Counted before the page is read so the header can say "25 of 340"
    // — without it, a paginated queue gives an operator no idea whether
    // the backlog is under control.
    const totalMatching = await tx.order.count({ where });

    const orders = await tx.order.findMany({
      where,
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
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
      //
      // `id` is appended as the final tiebreak so the sort is total.
      // Without it, two rows with equal priority, deadline and receipt
      // time have no defined order, and a cursor page boundary landing
      // between them could repeat or skip one.
      orderBy: [
        { priority: "desc" },
        { slaDeadlineAt: "asc" },
        { receivedAt: "asc" },
        { id: "asc" },
      ],
      // One extra row to learn whether another page exists, without a
      // second query. It is dropped below.
      take: limit + 1,
    });

    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;

    return Object.freeze({
      bucketExists: true,
      bucketId: bucket.id,
      bucketName: bucket.name,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalMatching,
      rows: page.map((o) =>
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
  readonly filters?: QueueFilters;
  /**
   * Cursors keyed by bucket code. Per-bucket because the caller renders
   * two independent lists — paging the TYPING list must not reset the
   * INBOX list beside it.
   */
  readonly cursors?: Readonly<Record<string, string | undefined>>;
}): Promise<Readonly<Record<string, ListBucketResult>>> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const out: Record<string, ListBucketResult> = {};
    // Sequential (not Promise.all): a Prisma interactive-transaction
    // client runs one query at a time on its single connection, so
    // concurrent issue would be unsafe. Sequential awaits still pay
    // the BEGIN/GUC/COMMIT exactly once for the whole batch.
    for (const bucketCode of input.bucketCodes) {
      const cursor = input.cursors?.[bucketCode];
      out[bucketCode] = await listOrdersInBucketByCode({
        organizationId: input.organizationId,
        bucketCode,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.filters !== undefined ? { filters: input.filters } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        tx,
      });
    }
    return Object.freeze(out);
  });
}
