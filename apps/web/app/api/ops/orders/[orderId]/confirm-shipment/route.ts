// POST /api/ops/orders/:orderId/confirm-shipment
//
// Shipping clerk confirms the physical hand-off to the carrier.
// Dispatches `ConfirmShipment` — transitions READY_TO_SHIP →
// SHIPPED (terminal primary state), stamps shipment.confirmedAt,
// emits `order.shipped.v1` to the outbox. The downstream
// `MaterializeShippedOrderBilling` handler projects this into
// billing-line creation. RBAC enforced by the command
// (`ship.confirm` permission).

import { ConfirmShipment } from "@pharmax/shipping";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: ConfirmShipment,
    idempotencyKeyPrefix: `route:confirm-shipment:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/shipping?flash=confirmed&orderId=${orderId}`,
    failureRedirect: `/ops/shipping`,
    successLogEvent: "ops.shipping.confirm.applied",
    failureLogEvent: "ops.shipping.confirm.failed",
  });
}
