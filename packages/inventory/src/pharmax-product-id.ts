// Pharmax Product ID allocation.
//
// The platform, not the operator, assigns compound catalog ids. This
// module is the only place that hands one out.
//
// Same design as the Rx-number allocator (`@pharmax/orders`
// rx-number.ts): a single `upsert` against
// `pharmax_product_id_sequence` increments the org's counter.
// Postgres compiles that to `INSERT … ON CONFLICT DO UPDATE`, so the
// increment holds a row lock for the remainder of the caller's
// transaction — two admins creating compounds at the same instant
// serialize on that lock and receive consecutive ids, and different
// orgs never contend at all.
//
// A number handed out by a transaction that later rolls back is
// simply lost. The series is allowed gaps; reclaiming numbers would
// make it non-monotonic, which is the property the audit story
// relies on.

import { errors } from "@pharmax/platform-core";
import type { PrismaTxClient } from "@pharmax/command-bus";
import { Prisma } from "@pharmax/database";

/**
 * Prefix of every Pharmax Product ID. "PXP" = Pharmax Product —
 * distinct from the "PX:" vial-label barcode namespace so a scanned
 * value can never be mistaken for a catalog id.
 */
export const PHARMAX_PRODUCT_ID_PREFIX = "PXP-";

/**
 * Width of the zero-padded numeric portion.
 *
 * Padding is not decoration: `product.pharmaxProductId` is TEXT, so
 * its unique index and every `ORDER BY` are lexicographic; without
 * padding "PXP-10" sorts before "PXP-9". Six digits is 1,000,000
 * compound definitions per org before the width grows — a catalog,
 * not an order stream, so that bound is effectively never.
 */
export const PHARMAX_PRODUCT_ID_PAD_WIDTH = 6;

/** Raised when the allocator cannot produce an id. */
export const PHARMAX_PRODUCT_ID_ALLOCATION_FAILED = "PHARMAX_PRODUCT_ID_ALLOCATION_FAILED";

/** Format an allocated counter value as the stored Pharmax Product ID. */
export function formatPharmaxProductId(value: number): string {
  return `${PHARMAX_PRODUCT_ID_PREFIX}${String(value).padStart(PHARMAX_PRODUCT_ID_PAD_WIDTH, "0")}`;
}

export interface AllocatePharmaxProductIdArgs {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
}

/**
 * Allocate the next Pharmax Product ID for an organization.
 *
 * MUST be called inside the creating transaction — the counter's row
 * lock is what serializes concurrent creations, and it only helps if
 * it is held until the product row commits alongside it.
 */
export async function allocatePharmaxProductId(
  args: AllocatePharmaxProductIdArgs
): Promise<string> {
  const { tx, organizationId } = args;

  try {
    const row = await tx.pharmaxProductIdSequence.upsert({
      where: { organizationId },
      // First allocation for this org: the row is created already
      // holding value 1, so the create and update branches agree that
      // `lastValue` is the id being handed out right now.
      create: { organizationId, lastValue: 1 },
      update: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });
    return formatPharmaxProductId(row.lastValue);
  } catch (err) {
    // P2002 here means two transactions raced to CREATE the counter
    // row for an org that had never minted a compound. Postgres
    // resolves that itself when the upsert compiles to ON CONFLICT,
    // but Prisma falls back to a non-atomic find-then-write for some
    // shapes, and the fallback can lose the race. Retry once as a
    // pure update: the row now demonstrably exists.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await tx.pharmaxProductIdSequence.update({
        where: { organizationId },
        data: { lastValue: { increment: 1 } },
        select: { lastValue: true },
      });
      return formatPharmaxProductId(row.lastValue);
    }
    throw new errors.InternalError({
      code: PHARMAX_PRODUCT_ID_ALLOCATION_FAILED,
      message: "Could not allocate a Pharmax Product ID for this organization.",
      metadata: { organizationId },
      cause: err,
    });
  }
}
