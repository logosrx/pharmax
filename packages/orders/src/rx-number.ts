// Rx number allocation.
//
// The pharmacy, not the operator, assigns prescription numbers. This
// module is the only place that hands one out.
//
// Allocation is a single `upsert` against `rx_number_sequence` that
// increments the clinic's counter. Postgres compiles that to
// `INSERT … ON CONFLICT DO UPDATE`, so the increment holds a row lock
// for the remainder of the caller's transaction: two technicians
// transcribing for the same clinic at the same instant serialize on
// that lock and receive consecutive numbers, and two technicians
// working different clinics never contend at all.
//
// The lock is held until the caller's transaction commits, which makes
// the ordering of statements inside `CreatePrescription` matter — see
// the note at the allocation call site there.

import { errors } from "@pharmax/platform-core";
import type { PrismaTxClient } from "@pharmax/command-bus";
import { Prisma } from "@pharmax/database";

/**
 * Width of the zero-padded numeric portion of an Rx number.
 *
 * Padding is not decoration. `prescription.rxNumber` is TEXT, so both
 * its unique index and every `ORDER BY rxNumber` are lexicographic;
 * without padding, "10" sorts before "9" and an operator scrolling the
 * Rx list sees the series out of order. Seven digits also matches the
 * width pharmacists are used to reading off a label.
 *
 * At 10,000,000 prescriptions for a single clinic the numbers grow an
 * eighth digit and lexicographic order breaks at that boundary. That
 * is roughly 400 years at 70 scripts a day; if it is ever approached,
 * widen the pad and backfill, do not wrap.
 */
export const RX_NUMBER_PAD_WIDTH = 7;

/** Raised when the allocator cannot produce a number. */
export const RX_NUMBER_ALLOCATION_FAILED = "RX_NUMBER_ALLOCATION_FAILED";

/** Format an allocated counter value as the stored Rx number. */
export function formatRxNumber(value: number): string {
  return String(value).padStart(RX_NUMBER_PAD_WIDTH, "0");
}

export interface AllocateRxNumberArgs {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly clinicId: string;
}

/**
 * Allocate the next Rx number for a clinic.
 *
 * MUST be called inside the transcribing transaction. A number handed
 * out by a transaction that later rolls back is simply lost — the
 * series is allowed to have gaps, and reclaiming numbers would make it
 * non-monotonic, which is the property auditors actually rely on.
 */
export async function allocateRxNumber(args: AllocateRxNumberArgs): Promise<string> {
  const { tx, organizationId, clinicId } = args;

  try {
    const row = await tx.rxNumberSequence.upsert({
      where: { organizationId_clinicId: { organizationId, clinicId } },
      // First allocation for this clinic: the row is created already
      // holding value 1, so the create and update branches agree that
      // `lastValue` is the number being handed out right now.
      create: { organizationId, clinicId, lastValue: 1 },
      update: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });
    return formatRxNumber(row.lastValue);
  } catch (err) {
    // P2002 here means two transactions raced to CREATE the counter
    // row for a clinic that had never been allocated from. Postgres
    // resolves that itself when the upsert compiles to ON CONFLICT,
    // but Prisma falls back to a non-atomic find-then-write for some
    // shapes, and the fallback can lose the race. Retry once as a
    // pure update: the row now demonstrably exists.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await tx.rxNumberSequence.update({
        where: { organizationId_clinicId: { organizationId, clinicId } },
        data: { lastValue: { increment: 1 } },
        select: { lastValue: true },
      });
      return formatRxNumber(row.lastValue);
    }
    throw new errors.InternalError({
      code: RX_NUMBER_ALLOCATION_FAILED,
      message: "Could not allocate a prescription number for this clinic.",
      metadata: { clinicId },
      cause: err,
    });
  }
}
