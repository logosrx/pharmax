// Single compound batch detail — drives
// `/ops/admin/compound-batches/[batchId]`.
//
// The batch row joined to its product and site, plus a serial-range
// summary. The unit rows themselves are NOT loaded: a batch can have
// thousands, every serial is derivable (`<batchNumber>-<n>`), and the
// detail page only needs the range.
//
// PHI: none. Tenancy: explicit organizationId predicate on top of RLS.

import "server-only";

import { readInOrgScope, type CompoundBatchStatus, type ProductUnitKind } from "@pharmax/database";

export interface CompoundBatchDetail {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly barcodeValue: string;
  readonly status: CompoundBatchStatus;
  readonly rejectionReasonCode: string | null;
  readonly daySequence: number;
  readonly compoundedOn: Date;
  readonly beyondUseDate: Date;
  readonly pastBud: boolean;
  readonly unitCount: number;
  readonly firstSerial: string;
  readonly lastSerial: string;
  readonly statusChangedAt: Date;
  readonly createdAt: Date;
  readonly productId: string;
  readonly productName: string;
  readonly productStrength: string | null;
  readonly productUnitKind: ProductUnitKind | null;
  readonly pharmaxProductId: string | null;
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
}

export async function getCompoundBatch(options: {
  readonly organizationId: string;
  readonly batchId: string;
}): Promise<CompoundBatchDetail | null> {
  return readInOrgScope(options.organizationId, async (tx) => {
    const row = await tx.compoundBatch.findFirst({
      where: { id: options.batchId, organizationId: options.organizationId },
      select: {
        id: true,
        batchNumber: true,
        barcodeValue: true,
        status: true,
        rejectionReasonCode: true,
        daySequence: true,
        compoundedOn: true,
        beyondUseDate: true,
        unitCount: true,
        statusChangedAt: true,
        createdAt: true,
        product: {
          select: {
            id: true,
            name: true,
            strength: true,
            unitKind: true,
            pharmaxProductId: true,
          },
        },
        site: { select: { id: true, code: true, name: true } },
      },
    });
    if (row === null) return null;

    return Object.freeze({
      batchId: row.id,
      batchNumber: row.batchNumber,
      barcodeValue: row.barcodeValue,
      status: row.status,
      rejectionReasonCode: row.rejectionReasonCode,
      daySequence: row.daySequence,
      compoundedOn: row.compoundedOn,
      beyondUseDate: row.beyondUseDate,
      pastBud: row.beyondUseDate < new Date(),
      unitCount: row.unitCount,
      firstSerial: `${row.batchNumber}-1`,
      lastSerial: `${row.batchNumber}-${row.unitCount}`,
      statusChangedAt: row.statusChangedAt,
      createdAt: row.createdAt,
      productId: row.product.id,
      productName: row.product.name,
      productStrength: row.product.strength,
      productUnitKind: row.product.unitKind,
      pharmaxProductId: row.product.pharmaxProductId,
      siteId: row.site.id,
      siteCode: row.site.code,
      siteName: row.site.name,
    });
  });
}
