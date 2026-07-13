import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { InventoryTransactionReason, LotStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { assertFillAssignee, assertFillInProgressWithAssignee } from "../fill-guards.js";

export const LOT_NOT_FOUND = "LOT_NOT_FOUND";
export const LOT_HELD = "LOT_HELD";
export const LOT_DEPLETED = "LOT_DEPLETED";
export const LOT_EXPIRED = "LOT_EXPIRED";
export const LOT_PRODUCT_MISMATCH = "LOT_PRODUCT_MISMATCH";
export const LOT_SITE_MISMATCH = "LOT_SITE_MISMATCH";
export const LOT_ALREADY_ASSIGNED_TO_LINE = "LOT_ALREADY_ASSIGNED_TO_LINE";
export const ORDER_LINE_NOT_FOUND = "ORDER_LINE_NOT_FOUND";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    lotId: z.uuid(),
  })
  .strict();

export type AssignLotInput = z.infer<typeof inputSchema>;

export interface AssignLotOutput {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly lotId: string;
  readonly lotAssignmentId: string;
  readonly version: number;
}

export const AssignLot = defineCommand<AssignLotInput, AssignLotOutput>({
  name: "AssignLot",
  inputSchema,
  permission: PERMISSIONS.FILL_ASSIGN_LOT,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: [],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "ASSIGN_LOT_NO_TARGET",
        message: "Locked order target was not provided to AssignLot.",
      });
    }

    assertFillInProgressWithAssignee({ target, ctx });
    await assertFillAssignee({ tx, target, ctx });

    const orderLine = await tx.orderLine.findFirst({
      where: {
        id: input.orderLineId,
        orderId: target.id,
        organizationId: ctx.organizationId,
      },
      select: {
        id: true,
        lotId: true,
        quantityToFill: true,
        prescription: { select: { drugNdc: true } },
      },
    });
    if (orderLine === null) {
      throw new errors.NotFoundError({
        code: ORDER_LINE_NOT_FOUND,
        message: "Order line not found on this order.",
        metadata: { orderId: target.id, orderLineId: input.orderLineId },
      });
    }

    const lot = await tx.lot.findFirst({
      where: { id: input.lotId, organizationId: ctx.organizationId },
      select: {
        id: true,
        siteId: true,
        lotNumber: true,
        expirationDate: true,
        status: true,
        product: { select: { ndc: true } },
      },
    });
    if (lot === null) {
      throw new errors.NotFoundError({
        code: LOT_NOT_FOUND,
        message: "Lot not found.",
        metadata: { lotId: input.lotId },
      });
    }

    if (lot.siteId !== target.siteId) {
      throw new errors.ConflictError({
        code: LOT_SITE_MISMATCH,
        message: "Lot belongs to a different pharmacy site than the order.",
        metadata: { lotId: lot.id, lotSiteId: lot.siteId, orderSiteId: target.siteId },
      });
    }

    // Only ACTIVE lots are assignable. Exhaustive over LotStatus so
    // a newly added status fails compilation until it is classified
    // here rather than silently passing validation.
    switch (lot.status) {
      case LotStatus.ACTIVE:
        break;
      case LotStatus.ON_HOLD:
        throw new errors.ConflictError({
          code: LOT_HELD,
          message: "Held lots cannot be assigned.",
          metadata: { lotId: lot.id, status: lot.status },
        });
      case LotStatus.DEPLETED:
        throw new errors.ConflictError({
          code: LOT_DEPLETED,
          message: "Depleted lots cannot be assigned.",
          metadata: { lotId: lot.id, status: lot.status },
        });
      default: {
        const exhaustive: never = lot.status;
        throw new errors.InternalError({
          code: "LOT_STATUS_UNHANDLED",
          message: `Unhandled lot status: ${String(exhaustive)}`,
        });
      }
    }

    const todayUtc = clock.now();
    const todayDate = new Date(
      Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate())
    );
    if (lot.expirationDate < todayDate) {
      throw new errors.ConflictError({
        code: LOT_EXPIRED,
        message: "Expired lots cannot be assigned.",
        metadata: {
          lotId: lot.id,
          expirationDate: lot.expirationDate.toISOString().slice(0, 10),
        },
      });
    }

    if (lot.product.ndc !== orderLine.prescription.drugNdc) {
      throw new errors.ConflictError({
        code: LOT_PRODUCT_MISMATCH,
        message: "Lot product NDC does not match the prescription NDC.",
        metadata: {
          lotId: lot.id,
          lotNdc: lot.product.ndc,
          prescriptionNdc: orderLine.prescription.drugNdc,
        },
      });
    }

    // Re-assignment handling. The order row is locked FOR UPDATE by
    // the factory, so concurrent AssignLot calls on this order
    // serialize and this read-check is race-free.
    //
    //   - Same lot already on the line → conflict. A retry of the
    //     same request replays via the idempotency key before ever
    //     reaching here, so hitting this branch means a genuinely
    //     duplicate action (double-pick in the UI).
    //   - DIFFERENT lot on the line → the tech is correcting a wrong
    //     pick. Reverse the previous deduction (LOT_RELEASED, +qty
    //     against the old lot) before deducting from the new lot, so
    //     the inventory ledger nets to exactly one open deduction
    //     per line. Without this, every re-pick double-deducted
    //     inventory and the ledger drifted from physical stock.
    const previousLotId = orderLine.lotId;
    if (previousLotId !== null) {
      if (previousLotId === lot.id) {
        throw new errors.ConflictError({
          code: LOT_ALREADY_ASSIGNED_TO_LINE,
          message: "This lot is already assigned to this order line.",
          metadata: { orderId: target.id, orderLineId: orderLine.id, lotId: lot.id },
        });
      }
      await tx.inventoryTransaction.create({
        data: {
          organizationId: ctx.organizationId,
          lotId: previousLotId,
          orderLineId: orderLine.id,
          quantityDelta: orderLine.quantityToFill,
          reason: InventoryTransactionReason.LOT_RELEASED,
          commandLogId,
        },
      });
    }

    const lotAssignment = await tx.lotAssignment.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        orderLineId: orderLine.id,
        lotId: lot.id,
        assignedByUserId: ctx.actor.userId,
        commandLogId,
      },
      select: { id: true },
    });

    await tx.inventoryTransaction.create({
      data: {
        organizationId: ctx.organizationId,
        lotId: lot.id,
        orderLineId: orderLine.id,
        quantityDelta: orderLine.quantityToFill.mul(-1),
        reason: InventoryTransactionReason.LOT_ASSIGNED,
        commandLogId,
      },
    });

    await tx.orderLine.update({
      where: { id: orderLine.id },
      data: { lotId: lot.id },
    });

    const fromVersion = target.version;
    const toVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        orderLineId: orderLine.id,
        lotId: lot.id,
        lotAssignmentId: lotAssignment.id,
        version: toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: fromVersion, to: toVersion },
      audit: {
        action: "fill.lot.assigned",
        resourceType: "OrderLine",
        resourceId: orderLine.id,
        metadata: {
          orderId: target.id,
          orderLineId: orderLine.id,
          lotId: lot.id,
          lotAssignmentId: lotAssignment.id,
          lotNumber: lot.lotNumber,
          commandLogId,
          // Non-null when this assignment CORRECTED a prior pick;
          // the released lot's deduction was reversed in this tx.
          releasedLotId: previousLotId,
        },
      },
      emits: [
        {
          eventType: "fill.lot.assigned.v1",
          aggregateType: "OrderLine",
          aggregateId: orderLine.id,
          payload: {
            organizationId: ctx.organizationId,
            orderId: target.id,
            orderLineId: orderLine.id,
            lotId: lot.id,
            lotAssignmentId: lotAssignment.id,
            occurredAt: clock.now().toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
