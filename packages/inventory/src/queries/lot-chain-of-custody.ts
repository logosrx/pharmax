// Lot chain-of-custody read (ADR-0035 slice 3) — the recall-response
// query: for one lot, everything from the door to the patient-facing
// order in a single PHI-safe view (identifiers only, no patient data).
//
//   inbound  — DSCSA receipts (who sold it to us, when, how much)
//   ledger   — every inventory movement with its reason
//   dispensed — order lines the lot was assigned to during fill
//   compounded — compounding records that consumed the lot as an
//                ingredient (finished preps made FROM this lot)
//
// Read-only; callers pass any Prisma client/transaction. RLS plus the
// explicit organizationId filter scope every query (belt and
// suspenders, per the tenancy rules).

import type { PrismaTxClient } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";

import { INVENTORY_LOT_NOT_FOUND } from "../shared.js";

export interface LotChainOfCustody {
  readonly lot: {
    readonly id: string;
    readonly siteId: string;
    readonly productId: string;
    readonly lotNumber: string;
    readonly expirationDate: string;
    readonly status: string;
  };
  readonly receipts: ReadonlyArray<{
    readonly dscsaTransactionId: string;
    readonly transactionDate: string;
    readonly shipmentDate: string | null;
    readonly sellerName: string;
    readonly quantity: string;
    readonly containerCount: number;
    readonly sourceDocumentRef: string | null;
    readonly receivedByUserId: string;
  }>;
  readonly ledger: ReadonlyArray<{
    readonly id: string;
    readonly quantityDelta: string;
    readonly reason: string;
    readonly orderLineId: string | null;
    readonly occurredAt: string;
  }>;
  readonly dispensed: ReadonlyArray<{
    readonly lotAssignmentId: string;
    readonly orderId: string;
    readonly orderLineId: string;
    readonly assignedByUserId: string;
    readonly assignedAt: string;
  }>;
  readonly compounded: ReadonlyArray<{
    readonly compoundingRecordId: string;
    readonly orderId: string;
    readonly orderLineId: string;
    readonly formulaCode: string;
    readonly formulaVersion: number;
    readonly preparedAt: string;
    readonly quantity: string;
  }>;
}

export async function getLotChainOfCustody(input: {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly lotId: string;
}): Promise<LotChainOfCustody> {
  const { tx, organizationId, lotId } = input;

  const lot = await tx.lot.findFirst({
    where: { id: lotId, organizationId },
    select: {
      id: true,
      siteId: true,
      productId: true,
      lotNumber: true,
      expirationDate: true,
      status: true,
    },
  });
  if (lot === null) {
    throw new errors.NotFoundError({
      code: INVENTORY_LOT_NOT_FOUND,
      message: "Lot not found.",
      metadata: { lotId },
    });
  }

  const [receipts, ledger, dispensed, compounded] = await Promise.all([
    tx.dscsaTransaction.findMany({
      where: { organizationId, lotId },
      orderBy: { transactionDate: "asc" },
      select: {
        id: true,
        transactionDate: true,
        shipmentDate: true,
        sellerName: true,
        quantity: true,
        containerCount: true,
        sourceDocumentRef: true,
        receivedByUserId: true,
      },
    }),
    tx.inventoryTransaction.findMany({
      where: { organizationId, lotId },
      orderBy: { occurredAt: "asc" },
      select: {
        id: true,
        quantityDelta: true,
        reason: true,
        orderLineId: true,
        occurredAt: true,
      },
    }),
    tx.lotAssignment.findMany({
      where: { organizationId, lotId },
      orderBy: { assignedAt: "asc" },
      select: {
        id: true,
        orderId: true,
        orderLineId: true,
        assignedByUserId: true,
        assignedAt: true,
      },
    }),
    tx.compoundingRecordIngredient.findMany({
      where: { organizationId, lotId },
      orderBy: { createdAt: "asc" },
      select: {
        quantity: true,
        record: {
          select: {
            id: true,
            orderId: true,
            orderLineId: true,
            formulaCode: true,
            formulaVersion: true,
            preparedAt: true,
          },
        },
      },
    }),
  ]);

  return {
    lot: {
      id: lot.id,
      siteId: lot.siteId,
      productId: lot.productId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate.toISOString().slice(0, 10),
      status: lot.status,
    },
    receipts: receipts.map((r) => ({
      dscsaTransactionId: r.id,
      transactionDate: r.transactionDate.toISOString().slice(0, 10),
      shipmentDate: r.shipmentDate === null ? null : r.shipmentDate.toISOString().slice(0, 10),
      sellerName: r.sellerName,
      quantity: r.quantity.toString(),
      containerCount: r.containerCount,
      sourceDocumentRef: r.sourceDocumentRef,
      receivedByUserId: r.receivedByUserId,
    })),
    ledger: ledger.map((t) => ({
      id: t.id,
      quantityDelta: t.quantityDelta.toString(),
      reason: t.reason,
      orderLineId: t.orderLineId,
      occurredAt: t.occurredAt.toISOString(),
    })),
    dispensed: dispensed.map((a) => ({
      lotAssignmentId: a.id,
      orderId: a.orderId,
      orderLineId: a.orderLineId,
      assignedByUserId: a.assignedByUserId,
      assignedAt: a.assignedAt.toISOString(),
    })),
    compounded: compounded.map((c) => ({
      compoundingRecordId: c.record.id,
      orderId: c.record.orderId,
      orderLineId: c.record.orderLineId,
      formulaCode: c.record.formulaCode,
      formulaVersion: c.record.formulaVersion,
      preparedAt: c.record.preparedAt.toISOString(),
      quantity: c.quantity.toString(),
    })),
  };
}
