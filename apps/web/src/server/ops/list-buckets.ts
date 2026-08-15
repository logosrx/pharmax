// List `bucket` rows for the admin UI.
//
// Returns every bucket in the org — system and custom alike — ordered
// the way the queue rail renders them (`sortOrder`, then `code` as a
// stable tiebreak, since `sortOrder` is not unique and an unstable sort
// would make the list jitter between reloads).
//
// The per-bucket order count is fetched with the row rather than on
// demand: it is what tells an operator whether DeleteBucket will be
// refused, so showing it up front turns "delete failed, 42 orders" into
// something they could see before clicking.

import "server-only";

import { readInTenantContext } from "@pharmax/database";
import type { BucketKind } from "@pharmax/database";
import type { TenancyContext } from "@pharmax/tenancy";

export interface BucketListRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: BucketKind;
  readonly sortOrder: number;
  readonly isSystem: boolean;
  readonly siteName: string | null;
  readonly clinicName: string | null;
  readonly teamName: string | null;
  /** Orders currently sitting in this bucket. Blocks deletion when > 0. */
  readonly orderCount: number;
}

const SELECT_FIELDS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  sortOrder: true,
  isSystem: true,
  site: { select: { name: true } },
  clinic: { select: { name: true } },
  team: { select: { name: true } },
  _count: { select: { orders: true } },
} as const;

type RawRow = {
  id: string;
  code: string;
  name: string;
  kind: BucketKind;
  sortOrder: number;
  isSystem: boolean;
  site: { name: string } | null;
  clinic: { name: string } | null;
  team: { name: string } | null;
  _count: { orders: number };
};

function freezeRow(row: RawRow): BucketListRow {
  return Object.freeze({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sortOrder,
    isSystem: row.isSystem,
    siteName: row.site?.name ?? null,
    clinicName: row.clinic?.name ?? null,
    teamName: row.team?.name ?? null,
    orderCount: row._count.orders,
  });
}

export async function listBuckets(input: {
  readonly tenancy: TenancyContext;
}): Promise<ReadonlyArray<BucketListRow>> {
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.bucket.findMany({
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: SELECT_FIELDS,
    });
    return rows.map((row) => freezeRow(row as RawRow));
  });
}

export async function getBucketById(input: {
  readonly tenancy: TenancyContext;
  readonly bucketId: string;
}): Promise<BucketListRow | null> {
  return readInTenantContext(input.tenancy, async (tx) => {
    const row = await tx.bucket.findFirst({
      where: { id: input.bucketId },
      select: SELECT_FIELDS,
    });
    if (row === null) return null;
    return freezeRow(row as RawRow);
  });
}
