// Compound batch number + unit serial construction.
//
// The identity printed on every batch label and vial:
//
//   batch number   MAIN-T30-1-081626
//                  │    │   │ └ compounding date, MMDDYY
//                  │    │   └── batch-of-the-day counter (1-based)
//                  │    └────── product serial identity: primary-drug
//                  │            initial + total mg per container
//                  └─────────── pharmacy site code
//
//   unit serial    MAIN-T30-1-081626-11   (batch number + unit number)
//
//   barcode value  PXB:PXP-000042:MAIN-T30-1-081626
//                  one scan resolves the product AND the batch.
//
// Everything here is a pure formatter. Uniqueness is NOT this
// module's job — the daySequence allocation race and the org-wide
// serial uniqueness are settled by the unique constraints on
// `compound_batch` / `compound_batch_unit` inside the creating
// transaction.

// Machine prefix for the batch barcode payload. "PXB" = Pharmax
// Batch; the colon-separated payload keeps the two human identifiers
// legible when a scanner types them into a text field.
export const COMPOUND_BATCH_BARCODE_PREFIX = "PXB";

// Site codes are operator-configured (`pharmacy_site.code`). Serials
// are dash-delimited, so a dash inside the site code would corrupt
// every parse downstream — normalize to A–Z/0–9 and refuse anything
// that normalizes to empty.
export function normalizeSiteSerialCode(siteCode: string): string | null {
  const normalized = siteCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.length === 0 ? null : normalized;
}

// "2026-08-16" → "081626". Serials quote the COMPOUNDING date, which
// is an operator-entered calendar date — formatting is a pure string
// rearrangement, deliberately free of Date/timezone math.
export function formatCompoundedOnCode(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month}${day}${year!.slice(2)}`;
}

export interface BuildBatchNumberArgs {
  /** Normalized site serial code (see normalizeSiteSerialCode). */
  readonly siteCode: string;
  /** Frozen product serial identity, e.g. "T" + 30. */
  readonly serialDrugInitial: string;
  readonly serialDrugMg: number;
  /** 1-based batch-of-the-day counter. */
  readonly daySequence: number;
  /** ISO compounding date, e.g. "2026-08-16". */
  readonly compoundedOn: string;
}

export function buildBatchNumber(args: BuildBatchNumberArgs): string {
  const drugCode = `${args.serialDrugInitial}${args.serialDrugMg}`;
  const dateCode = formatCompoundedOnCode(args.compoundedOn);
  return `${args.siteCode}-${drugCode}-${args.daySequence}-${dateCode}`;
}

export function buildUnitSerial(batchNumber: string, unitNumber: number): string {
  return `${batchNumber}-${unitNumber}`;
}

export function buildBatchBarcodeValue(pharmaxProductId: string, batchNumber: string): string {
  return `${COMPOUND_BATCH_BARCODE_PREFIX}:${pharmaxProductId}:${batchNumber}`;
}
