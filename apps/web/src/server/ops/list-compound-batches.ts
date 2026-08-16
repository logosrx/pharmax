// Compound batch projection — drives `/ops/admin/compound-batches`.
//
// Paginated list of the org's compound batches joined to product +
// pharmacy site, newest first (the ops-useful order: today's bench
// work on top). Supports optional status and product filters.
//
// Read-only: all mutations go through the batch lifecycle commands.
//
// PHI: none — batch numbers, catalog identity, and site codes are
// not PHI.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope, type CompoundBatchStatus } from "@pharmax/database";
import { isPastBeyondUseDate } from "@pharmax/inventory";

export interface CompoundBatchListRow {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly status: CompoundBatchStatus;
  readonly compoundedOn: Date;
  readonly beyondUseDate: Date;
  /** True when the Beyond-Use Date is in the past (dispense-blocked). */
  readonly pastBud: boolean;
  readonly unitCount: number;
  readonly productId: string;
  readonly productName: string;
  readonly productStrength: string | null;
  readonly pharmaxProductId: string | null;
  readonly siteCode: string;
  readonly siteName: string;
  readonly createdAt: Date;
}

export interface ListCompoundBatchesOptions {
  readonly organizationId: string;
  readonly status?: CompoundBatchStatus;
  /** Restrict to one product (drill-in from the catalog page). */
  readonly productId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListCompoundBatchesResult {
  readonly rows: ReadonlyArray<CompoundBatchListRow>;
  /** Cursor for the next page; null when no more rows. */
  readonly nextCursor: string | null;
}

export async function listCompoundBatches(
  options: ListCompoundBatchesOptions
): Promise<ListCompoundBatchesResult> {
  const limit = Math.min(options.limit ?? 50, 200);

  return readInOrgScope(options.organizationId, async (tx) => {
    const rows = await tx.compoundBatch.findMany({
      where: {
        organizationId: options.organizationId,
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.productId !== undefined ? { productId: options.productId } : {}),
      },
      select: {
        id: true,
        batchNumber: true,
        status: true,
        compoundedOn: true,
        beyondUseDate: true,
        unitCount: true,
        createdAt: true,
        product: { select: { id: true, name: true, strength: true, pharmaxProductId: true } },
        site: { select: { code: true, name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const now = new Date();
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;

    return Object.freeze({
      rows: sliced.map((r) =>
        Object.freeze({
          batchId: r.id,
          batchNumber: r.batchNumber,
          status: r.status,
          compoundedOn: r.compoundedOn,
          beyondUseDate: r.beyondUseDate,
          pastBud: isPastBeyondUseDate(r.beyondUseDate, now),
          unitCount: r.unitCount,
          productId: r.product.id,
          productName: r.product.name,
          productStrength: r.product.strength,
          pharmaxProductId: r.product.pharmaxProductId,
          siteCode: r.site.code,
          siteName: r.site.name,
          createdAt: r.createdAt,
        })
      ),
      nextCursor,
    });
  });
}
