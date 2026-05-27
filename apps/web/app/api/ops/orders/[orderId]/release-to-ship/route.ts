// POST /api/ops/orders/:orderId/release-to-ship
//
// Shipping clerk releases a final-verified order to shipping.
// Dispatches `ReleaseToShip` — transitions
// FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP → READY_TO_SHIP and
// stamps the operator as `currentAssigneeUserId` so the
// downstream CreateShipment / ConfirmShipment commands accept
// the same operator's actions via the shipping-assignee guards.
// RBAC enforced by the command (`ship.release` permission).

import { ReleaseToShip } from "@pharmax/shipping";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: ReleaseToShip,
    idempotencyKeyPrefix: `route:release-to-ship:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/shipping?flash=released&orderId=${orderId}`,
    failureRedirect: `/ops/shipping`,
    successLogEvent: "ops.shipping.release.applied",
    failureLogEvent: "ops.shipping.release.failed",
  });
}
