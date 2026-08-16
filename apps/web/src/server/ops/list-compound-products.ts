// In-house compound products for the batch-creation form.
//
// The `<select>` on `/ops/admin/compound-batches/new` needs every
// compound the org can batch: catalog identity + the frozen serial
// identity so the form can preview the batch number live. Compounds
// only — manufactured stock arrives through DSCSA receiving, never
// through batch creation.
//
// Bounded: an org's compound catalog is admin-curated and small
// (tens, not thousands); the take() is a guardrail, not pagination.
//
// PHI: none. Tenancy: explicit organizationId predicate on top of RLS.

import "server-only";

import { ProductNdcKind, readInOrgScope, type ProductUnitKind } from "@pharmax/database";

export interface CompoundProductOption {
  readonly productId: string;
  readonly name: string;
  readonly strength: string | null;
  readonly pharmaxProductId: string | null;
  readonly unitKind: ProductUnitKind | null;
  readonly serialDrugInitial: string | null;
  readonly serialDrugMg: number | null;
}

export async function listCompoundProducts(options: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<CompoundProductOption>> {
  return readInOrgScope(options.organizationId, async (tx) => {
    const rows = await tx.product.findMany({
      where: {
        organizationId: options.organizationId,
        ndcKind: ProductNdcKind.IN_HOUSE_COMPOUND,
      },
      select: {
        id: true,
        name: true,
        strength: true,
        pharmaxProductId: true,
        unitKind: true,
        serialDrugInitial: true,
        serialDrugMg: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 500,
    });

    return rows.map((r) =>
      Object.freeze({
        productId: r.id,
        name: r.name,
        strength: r.strength,
        pharmaxProductId: r.pharmaxProductId,
        unitKind: r.unitKind,
        serialDrugInitial: r.serialDrugInitial,
        serialDrugMg: r.serialDrugMg,
      })
    );
  });
}
