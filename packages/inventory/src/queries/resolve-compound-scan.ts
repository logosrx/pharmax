// Resolve a scanned compound stock label to the rows it identifies,
// and report whether that stock is fit to dispense.
//
// This is the read half of compound traceability: a technician or
// shipping clerk scans a vial and needs two things at once — WHAT is
// this (product, batch, unit), and MAY I use it. Answering only the
// first invites the second to be assumed.
//
// The verdict is advisory here by design. This module is a query; it
// cannot enforce anything, and a caller that ignores `blockers` gets no
// protection from it. The binding command in the next slice re-derives
// the same checks inside its transaction, because a verdict computed
// before a lock is a verdict about the past. Presenting it here is
// still worth it: the console can refuse the scan before an operator
// picks up a vial they must then put back.
//
// PHI: none. A batch has no patient, and the scan token is a
// production identifier.

import type { PrismaTxClient } from "@pharmax/command-bus";
import { CompoundBatchStatus } from "@pharmax/database";

import { isPastBeyondUseDate } from "../compound-batch-bud.js";

/** Why scanned stock must not be dispensed. */
export const SCAN_BLOCKER_PAST_BUD = "PAST_BUD";
export const SCAN_BLOCKER_BATCH_REJECTED = "BATCH_REJECTED";
export const SCAN_BLOCKER_BATCH_NOT_RELEASED = "BATCH_NOT_RELEASED";

export const COMPOUND_SCAN_BLOCKERS = [
  SCAN_BLOCKER_PAST_BUD,
  SCAN_BLOCKER_BATCH_REJECTED,
  SCAN_BLOCKER_BATCH_NOT_RELEASED,
] as const;

export type CompoundScanBlocker = (typeof COMPOUND_SCAN_BLOCKERS)[number];

export interface ResolvedCompoundScan {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly status: CompoundBatchStatus;
  readonly beyondUseDate: Date;
  readonly siteId: string;
  readonly siteCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly productStrength: string | null;
  readonly pharmaxProductId: string | null;
  readonly unitCount: number;
  /** Set only when a UNIT serial was scanned, not a batch barcode. */
  readonly unitId: string | null;
  readonly unitNumber: number | null;
  readonly serialNumber: string | null;
  /**
   * Empty when this stock is dispensable. Non-empty means it is not,
   * and each entry says why.
   */
  readonly blockers: ReadonlyArray<CompoundScanBlocker>;
}

export interface ResolveCompoundScanArgs {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  /** Already-parsed scan; the parser lives in `@pharmax/scan`. */
  readonly scan:
    | { readonly kind: "COMPOUND_BATCH"; readonly batchNumber: string }
    | { readonly kind: "COMPOUND_UNIT"; readonly serialNumber: string };
  /** Evaluation instant for the Beyond-Use Date check. */
  readonly now: Date;
}

function deriveBlockers(
  status: CompoundBatchStatus,
  beyondUseDate: Date,
  now: Date
): ReadonlyArray<CompoundScanBlocker> {
  const blockers: CompoundScanBlocker[] = [];

  if (status === CompoundBatchStatus.REJECTED) {
    blockers.push(SCAN_BLOCKER_BATCH_REJECTED);
  } else if (status !== CompoundBatchStatus.RELEASED && status !== CompoundBatchStatus.DISPENSING) {
    // COMPOUNDED or TESTING: real product, but the lab has not cleared
    // it. Reported separately from REJECTED because the remedies
    // differ — this batch may still be released, a rejected one never
    // will be.
    blockers.push(SCAN_BLOCKER_BATCH_NOT_RELEASED);
  }

  // Checked independently of status: a released batch that has since
  // passed its BUD is exactly the case a status check alone misses.
  if (isPastBeyondUseDate(beyondUseDate, now)) {
    blockers.push(SCAN_BLOCKER_PAST_BUD);
  }

  return Object.freeze(blockers);
}

/**
 * Resolve a scanned compound label. Returns `null` when the token
 * identifies nothing in this organization — a not-found is a normal
 * outcome for a mistyped or foreign barcode, not an exception.
 */
export async function resolveCompoundScan(
  args: ResolveCompoundScanArgs
): Promise<ResolvedCompoundScan | null> {
  const batchSelect = {
    id: true,
    batchNumber: true,
    status: true,
    beyondUseDate: true,
    unitCount: true,
    siteId: true,
    site: { select: { code: true } },
    product: {
      select: { id: true, name: true, strength: true, pharmaxProductId: true },
    },
  } as const;

  if (args.scan.kind === "COMPOUND_UNIT") {
    // The org-wide unique index on serialNumber is what makes one scan
    // resolve to one vial.
    const unit = await args.tx.compoundBatchUnit.findFirst({
      where: {
        organizationId: args.organizationId,
        serialNumber: args.scan.serialNumber,
      },
      select: {
        id: true,
        unitNumber: true,
        serialNumber: true,
        batch: { select: batchSelect },
      },
    });
    if (unit === null) return null;

    const batch = unit.batch;
    return Object.freeze({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      status: batch.status,
      beyondUseDate: batch.beyondUseDate,
      siteId: batch.siteId,
      siteCode: batch.site.code,
      productId: batch.product.id,
      productName: batch.product.name,
      productStrength: batch.product.strength,
      pharmaxProductId: batch.product.pharmaxProductId,
      unitCount: batch.unitCount,
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      serialNumber: unit.serialNumber,
      blockers: deriveBlockers(batch.status, batch.beyondUseDate, args.now),
    });
  }

  const batch = await args.tx.compoundBatch.findFirst({
    where: { organizationId: args.organizationId, batchNumber: args.scan.batchNumber },
    select: batchSelect,
  });
  if (batch === null) return null;

  return Object.freeze({
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    status: batch.status,
    beyondUseDate: batch.beyondUseDate,
    siteId: batch.siteId,
    siteCode: batch.site.code,
    productId: batch.product.id,
    productName: batch.product.name,
    productStrength: batch.product.strength,
    pharmaxProductId: batch.product.pharmaxProductId,
    unitCount: batch.unitCount,
    unitId: null,
    unitNumber: null,
    serialNumber: null,
    blockers: deriveBlockers(batch.status, batch.beyondUseDate, args.now),
  });
}
