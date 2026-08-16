// Product catalog projection — drives `/ops/admin/products`.
//
// Paginated list of the org's drug catalog (Product rows keyed by
// normalized NDC). Supports an optional `q` filter matched against
// the product name (case-insensitive contains) or NDC prefix.
//
// PHI: none — NDC + drug name are plaintext by design (not PHI).
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

export interface ProductListRow {
  readonly productId: string;
  readonly ndc: string;
  readonly name: string;
  readonly strength: string | null;
  readonly form: string | null;
  /** True for in-house compounds (org-local identifier in `ndc`). */
  readonly isCompound: boolean;
  /** Minted catalog id ("PXP-000042"); null on NATIONAL products. */
  readonly pharmaxProductId: string | null;
  /** Total lot rows referencing this product (all statuses). */
  readonly lotCount: number;
  readonly createdAt: Date;
}

export interface ListProductsOptions {
  readonly organizationId: string;
  /** Matches name (contains, case-insensitive) or NDC prefix. */
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListProductsResult {
  readonly rows: ReadonlyArray<ProductListRow>;
  /** Cursor for the next page; null when no more rows. */
  readonly nextCursor: string | null;
}

export async function listProducts(options: ListProductsOptions): Promise<ListProductsResult> {
  const limit = Math.min(options.limit ?? 50, 200);

  return readInOrgScope(options.organizationId, async (tx) => {
    const rows = await tx.product.findMany({
      where: {
        organizationId: options.organizationId,
        ...(options.q !== undefined
          ? {
              OR: [
                { name: { contains: options.q, mode: "insensitive" } },
                { ndc: { startsWith: options.q } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        ndc: true,
        name: true,
        strength: true,
        form: true,
        ndcKind: true,
        pharmaxProductId: true,
        createdAt: true,
        _count: { select: { lots: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;

    return Object.freeze({
      rows: sliced.map((r) =>
        Object.freeze({
          productId: r.id,
          ndc: r.ndc,
          name: r.name,
          strength: r.strength,
          form: r.form,
          isCompound: r.ndcKind === "IN_HOUSE_COMPOUND",
          pharmaxProductId: r.pharmaxProductId,
          lotCount: r._count.lots,
          createdAt: r.createdAt,
        })
      ),
      nextCursor,
    });
  });
}
