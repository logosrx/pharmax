/**
 * Batch-level label for in-house compounded stock. No patient exists
 * at compounding time, so nothing here is PHI — it is catalog and
 * production identity only.
 */
export interface CompoundBatchLabelRenderInput {
  readonly productName: string;
  readonly productStrength: string | null;
  readonly pharmaxProductId: string;
  readonly batchNumber: string;
  /** ISO date, printed as-is. */
  readonly compoundedOn: string;
  /** ISO date. Beyond-Use Date, USP <797>. */
  readonly beyondUseDate: string;
  readonly unitCount: number;
  /** `PXB:<pharmaxProductId>:<batchNumber>` — scanned verbatim. */
  readonly batchBarcodeValue: string;
}

/**
 * Per-unit label for one vial/tablet/… of a compound batch. The serial
 * is both the printed identity and the barcode payload.
 */
export interface CompoundUnitLabelRenderInput {
  readonly productName: string;
  readonly productStrength: string | null;
  /** ISO date. Beyond-Use Date, USP <797>. */
  readonly beyondUseDate: string;
  readonly unitNumber: number;
  readonly unitCount: number;
  /** `<batchNumber>-<unitNumber>`, e.g. "PHX-T30-1-040327-11". */
  readonly serialNumber: string;
}

export interface VialLabelRenderInput {
  readonly patientDisplayName: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly drugNdc: string;
  readonly rxNumber: string;
  readonly quantity: string;
  readonly daysSupply: number;
  readonly sigText: string;
  readonly lotNumber: string;
  readonly lotExpiration: string;
  readonly barcodeValue: string;
}
