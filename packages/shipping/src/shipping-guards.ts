import type { LockedOrderTarget, PrismaTxClient } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import type { TenancyContext } from "@pharmax/tenancy";

export const SHIP_WRONG_STATUS = "SHIP_WRONG_STATUS";
export const SHIP_NOT_ASSIGNED_TO_ACTOR = "SHIP_NOT_ASSIGNED_TO_ACTOR";

export function assertReadyToShipWithAssignee(input: {
  readonly target: LockedOrderTarget;
  readonly ctx: TenancyContext;
}): void {
  if (input.target.currentStatus !== OrderStatus.READY_TO_SHIP) {
    throw new errors.ConflictError({
      code: SHIP_WRONG_STATUS,
      message: "Order must be in READY_TO_SHIP for this shipping command.",
      metadata: {
        orderId: input.target.id,
        currentStatus: input.target.currentStatus,
        requiredStatus: OrderStatus.READY_TO_SHIP,
      },
    });
  }
}

export async function assertShippingAssignee(input: {
  readonly tx: PrismaTxClient;
  readonly target: LockedOrderTarget;
  readonly ctx: TenancyContext;
}): Promise<void> {
  const assigneeRow = await input.tx.order.findFirst({
    where: { id: input.target.id, organizationId: input.ctx.organizationId },
    select: { currentAssigneeUserId: true },
  });
  const assigneeUserId = assigneeRow?.currentAssigneeUserId ?? null;
  if (assigneeUserId !== input.ctx.actor.userId) {
    throw new errors.AuthorizationError({
      code: SHIP_NOT_ASSIGNED_TO_ACTOR,
      message: "Order is not assigned to the current user for shipping work.",
      metadata: {
        orderId: input.target.id,
        assigneeUserId,
        actorUserId: input.ctx.actor.userId,
      },
    });
  }
}
