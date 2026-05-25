import type { LockedOrderTarget, PrismaTxClient } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import type { TenancyContext } from "@pharmax/tenancy";

export const FILL_POLICY_UNSUPPORTED = "FILL_POLICY_UNSUPPORTED";
export const FILL_ORDER_STATE_UNKNOWN = "FILL_ORDER_STATE_UNKNOWN";
export const FILL_INVALID_TRANSITION = "FILL_INVALID_TRANSITION";
export const FILL_ORDER_TERMINAL = "FILL_ORDER_TERMINAL";
export const FILL_NOT_ASSIGNED_TO_ACTOR = "FILL_NOT_ASSIGNED_TO_ACTOR";
export const FILL_WRONG_STATUS = "FILL_WRONG_STATUS";

export function assertFillInProgressWithAssignee(input: {
  readonly target: LockedOrderTarget;
  readonly ctx: TenancyContext;
}): void {
  if (input.target.currentStatus !== OrderStatus.FILL_IN_PROGRESS) {
    throw new errors.ConflictError({
      code: FILL_WRONG_STATUS,
      message: "Order must be in FILL_IN_PROGRESS for this fill command.",
      metadata: {
        orderId: input.target.id,
        currentStatus: input.target.currentStatus,
        requiredStatus: OrderStatus.FILL_IN_PROGRESS,
      },
    });
  }
}

export async function assertFillAssignee(input: {
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
      code: FILL_NOT_ASSIGNED_TO_ACTOR,
      message: "Order is not assigned to the current user for fill work.",
      metadata: {
        orderId: input.target.id,
        assigneeUserId,
        actorUserId: input.ctx.actor.userId,
      },
    });
  }
}
