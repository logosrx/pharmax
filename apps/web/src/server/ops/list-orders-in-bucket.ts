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

import { prisma, type OrderPriority, type OrderStatus } from "@pharmax/database";

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
}): Promise<ListBucketResult> {
  const limit = Math.min(input.limit ?? 100, 500);

  const bucket = await prisma.bucket.findUnique({
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

  const orders = await prisma.order.findMany({
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
}
