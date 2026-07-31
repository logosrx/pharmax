// Inventory lot (batch) projection — drives `/ops/admin/batches`.
//
// Paginated list of the org's inventory lots joined to product +
// pharmacy site, ordered by soonest expiration first (the ops-useful
// order: what do I need to rotate out next). Supports an optional
// status filter.
//
// Read-only: lot assignment / hold / depletion stay behind the fill
// workflow commands — this page never mutates.
//
// PHI: none — lot numbers, NDCs, and site codes are not PHI.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope, type LotStatus } from "@pharmax/database";

export interface LotListRow {
  readonly lotId: string;
  readonly lotNumber: string;
  readonly status: LotStatus;
  readonly expirationDate: Date;
  /** True when the expiration date is in the past (assignment-blocked). */
  readonly expired: boolean;
  readonly productId: string;
  readonly productNdc: string;
  readonly productName: string;
  readonly productStrength: string | null;
  readonly siteCode: string;
  readonly siteName: string;
  readonly createdAt: Date;
}

export interface ListLotsOptions {
  readonly organizationId: string;
  readonly status?: LotStatus;
  /** Restrict to one product (drill-in from the catalog page). */
  readonly productId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListLotsResult {
  readonly rows: ReadonlyArray<LotListRow>;
  /** Cursor for the next page; null when no more rows. */
  readonly nextCursor: string | null;
}

export async function listLots(options: ListLotsOptions): Promise<ListLotsResult> {
  const limit = Math.min(options.limit ?? 50, 200);

  return readInOrgScope(options.organizationId, async (tx) => {
    const rows = await tx.lot.findMany({
      where: {
        organizationId: options.organizationId,
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.productId !== undefined ? { productId: options.productId } : {}),
      },
      select: {
        id: true,
        lotNumber: true,
        status: true,
        expirationDate: true,
        createdAt: true,
        product: { select: { id: true, ndc: true, name: true, strength: true } },
        site: { select: { code: true, name: true } },
      },
      orderBy: [{ expirationDate: "asc" }, { id: "asc" }],
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
          lotId: r.id,
          lotNumber: r.lotNumber,
          status: r.status,
          expirationDate: r.expirationDate,
          expired: r.expirationDate < now,
          productId: r.product.id,
          productNdc: r.product.ndc,
          productName: r.product.name,
          productStrength: r.product.strength,
          siteCode: r.site.code,
          siteName: r.site.name,
          createdAt: r.createdAt,
        })
      ),
      nextCursor,
    });
  });
}
