// ReceiveLot — receive an inbound lot shipment with its DSCSA
// transaction record (ADR-0035 slice 3; 21 USC 360eee).
//
// One command, one receipt, three writes in one transaction:
//
//   1. The `Lot` row — created on first arrival of this
//      (site, product, lotNumber), reused on subsequent shipments of
//      the same lot. A concurrent first receipt is serialized by the
//      lot unique constraint (P2002 → typed retryable conflict).
//   2. A `LOT_RECEIVED` inventory-ledger credit, so on-hand remains a
//      pure ledger fold (receipts +, assignments/consumptions −).
//   3. The `dscsa_transaction` row: a structured Transaction
//      Information snapshot plus the Transaction Statement gate — the
//      command REFUSES receipt when the seller's TS did not accompany
//      the shipment, and refuses stock that is already expired
//      (extending "no expired lot assignment" upstream to the door).
//
// The TI's NDC comes from OUR catalog product, not from input — the
// receipt binds the shipment to the catalog row the lot hangs off.
//
// Receipts never change lot STATUS: receiving more of an ON_HOLD lot
// does not lift the hold (a hold is a quality decision, not a
// quantity fact), and a DEPLETED lot is not resurrected silently.
//
// Non-order aggregate: plain `Command` shape (no order lock), like
// the compound-formula lifecycle commands. Supply-chain data only —
// no PHI anywhere in this command.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { InventoryTransactionReason, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  INVENTORY_EXPIRATION_MISMATCH,
  INVENTORY_LOT_EXPIRED_AT_RECEIPT,
  INVENTORY_PRODUCT_NOT_FOUND,
  INVENTORY_RECEIPT_CONFLICT,
  INVENTORY_SITE_NOT_FOUND,
  INVENTORY_TS_NOT_RECEIVED,
} from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const dscsaSchema = z
  .object({
    /** TI product identity as it appears on the transaction document. */
    productName: z.string().min(1).max(300),
    strength: z.string().min(1).max(100),
    dosageForm: z.string().min(1).max(100),
    containerSize: z.string().min(1).max(100),
    containerCount: z.int().positive().max(100000),
    transactionDate: z.iso.date(),
    /** Only when it differs from the transaction date (statute). */
    shipmentDate: z.iso.date().optional(),
    sellerName: z.string().min(1).max(300),
    sellerAddress: z.string().min(1).max(1000),
    buyerName: z.string().min(1).max(300),
    buyerAddress: z.string().min(1).max(1000),
    /** The seller's Transaction Statement accompanied the shipment.
     *  Must be true — enforced in-handler with a typed error. */
    transactionStatementReceived: z.boolean(),
    /** EPCIS event/file id, ASN, or invoice reference. */
    sourceDocumentRef: z.string().min(1).max(300).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    siteId: z.uuid(),
    productId: z.uuid(),
    lotNumber: z.string().min(1).max(120),
    expirationDate: z.iso.date(),
    quantity: z.coerce
      .number()
      .positive()
      .refine((n) => Number.isFinite(n), "must be finite"),
    dscsa: dscsaSchema,
  })
  .strict();

export type ReceiveLotInput = z.infer<typeof inputSchema>;

export interface ReceiveLotOutput {
  readonly lotId: string;
  readonly lotCreated: boolean;
  readonly dscsaTransactionId: string;
  readonly lotNumber: string;
  readonly quantity: number;
}

function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const ReceiveLot: Command<ReceiveLotInput, ReceiveLotOutput> = {
  name: "ReceiveLot",
  inputSchema,
  permission: PERMISSIONS.INVENTORY_RECEIVE,

  async handle({ input, ctx, tx, commandLogId, clock }): Promise<HandlerResult<ReceiveLotOutput>> {
    const now = clock.now();

    // Statutory gate first: a dispenser may not accept product
    // without the seller's Transaction Statement.
    if (!input.dscsa.transactionStatementReceived) {
      throw new errors.ValidationError({
        code: INVENTORY_TS_NOT_RECEIVED,
        message:
          "The seller's DSCSA Transaction Statement must accompany the shipment; receipt refused without it.",
        metadata: { lotNumber: input.lotNumber },
      });
    }

    const expirationDate = utcDate(input.expirationDate);
    const todayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (expirationDate < todayDate) {
      throw new errors.ValidationError({
        code: INVENTORY_LOT_EXPIRED_AT_RECEIPT,
        message: "Already-expired stock cannot be received.",
        metadata: { lotNumber: input.lotNumber, expirationDate: input.expirationDate },
      });
    }

    const site = await tx.pharmacySite.findFirst({
      where: { id: input.siteId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (site === null) {
      throw new errors.NotFoundError({
        code: INVENTORY_SITE_NOT_FOUND,
        message: "Pharmacy site not found in this organization.",
        metadata: { siteId: input.siteId },
      });
    }

    const product = await tx.product.findFirst({
      where: { id: input.productId, organizationId: ctx.organizationId },
      select: { id: true, ndc: true },
    });
    if (product === null) {
      throw new errors.NotFoundError({
        code: INVENTORY_PRODUCT_NOT_FOUND,
        message: "Product not found in this organization's catalog.",
        metadata: { productId: input.productId },
      });
    }

    // Create-or-extend the lot. The unique (org, site, product,
    // lotNumber) serializes concurrent FIRST receipts; a same-lot
    // second shipment reuses the row.
    const existing = await tx.lot.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: input.siteId,
        productId: input.productId,
        lotNumber: input.lotNumber,
      },
      select: { id: true, expirationDate: true },
    });

    let lotId: string;
    let lotCreated: boolean;
    if (existing !== null) {
      // Same lot number arriving with a DIFFERENT expiration is a
      // data problem (mislabeled shipment or entry error), not a
      // mergeable receipt.
      if (existing.expirationDate.getTime() !== expirationDate.getTime()) {
        throw new errors.ConflictError({
          code: INVENTORY_EXPIRATION_MISMATCH,
          message:
            "This lot already exists with a different expiration date; verify the shipment before receiving.",
          metadata: {
            lotId: existing.id,
            lotNumber: input.lotNumber,
            existingExpirationDate: existing.expirationDate.toISOString().slice(0, 10),
            receivedExpirationDate: input.expirationDate,
          },
        });
      }
      lotId = existing.id;
      lotCreated = false;
    } else {
      lotId = randomUUID();
      lotCreated = true;
      try {
        await tx.lot.create({
          data: {
            id: lotId,
            organizationId: ctx.organizationId,
            siteId: input.siteId,
            productId: input.productId,
            lotNumber: input.lotNumber,
            expirationDate,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new errors.ConflictError({
            code: INVENTORY_RECEIPT_CONFLICT,
            message: "A concurrent receipt created this lot; retry the receipt.",
            metadata: { lotNumber: input.lotNumber },
          });
        }
        throw err;
      }
    }

    await tx.inventoryTransaction.create({
      data: {
        organizationId: ctx.organizationId,
        lotId,
        quantityDelta: new Prisma.Decimal(input.quantity),
        reason: InventoryTransactionReason.LOT_RECEIVED,
        commandLogId,
      },
    });

    const dscsaTransactionId = randomUUID();
    await tx.dscsaTransaction.create({
      data: {
        id: dscsaTransactionId,
        organizationId: ctx.organizationId,
        lotId,
        productName: input.dscsa.productName,
        strength: input.dscsa.strength,
        dosageForm: input.dscsa.dosageForm,
        ndc: product.ndc,
        containerSize: input.dscsa.containerSize,
        containerCount: input.dscsa.containerCount,
        lotNumber: input.lotNumber,
        quantity: new Prisma.Decimal(input.quantity),
        transactionDate: utcDate(input.dscsa.transactionDate),
        ...(input.dscsa.shipmentDate === undefined
          ? {}
          : { shipmentDate: utcDate(input.dscsa.shipmentDate) }),
        sellerName: input.dscsa.sellerName,
        sellerAddress: input.dscsa.sellerAddress,
        buyerName: input.dscsa.buyerName,
        buyerAddress: input.dscsa.buyerAddress,
        transactionStatementReceived: true,
        ...(input.dscsa.sourceDocumentRef === undefined
          ? {}
          : { sourceDocumentRef: input.dscsa.sourceDocumentRef }),
        receivedByUserId: ctx.actor.userId,
        commandLogId,
      },
    });

    return {
      output: {
        lotId,
        lotCreated,
        dscsaTransactionId,
        lotNumber: input.lotNumber,
        quantity: input.quantity,
      },
      audit: {
        action: "inventory.lot.received",
        resourceType: "Lot",
        resourceId: lotId,
        metadata: {
          siteId: input.siteId,
          productId: input.productId,
          lotNumber: input.lotNumber,
          expirationDate: input.expirationDate,
          quantity: input.quantity,
          lotCreated,
          dscsaTransactionId,
          sellerName: input.dscsa.sellerName,
          transactionDate: input.dscsa.transactionDate,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "inventory.lot.received.v1",
          aggregateType: "Lot",
          aggregateId: lotId,
          payload: {
            dscsaTransactionId,
            organizationId: ctx.organizationId,
            siteId: input.siteId,
            lotId,
            productId: input.productId,
            lotNumber: input.lotNumber,
            quantity: input.quantity,
            lotCreated,
            receivedByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
