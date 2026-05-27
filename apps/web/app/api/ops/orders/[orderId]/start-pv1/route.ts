// POST /api/ops/orders/:orderId/start-pv1
//
// Operator action (pharmacist claims an order from the PV1 queue).
// Dispatches the standard `StartPV1` command. RBAC enforced by
// the command (`pv1.start` permission).

import { StartPV1 } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: StartPV1,
    idempotencyKeyPrefix: `route:start-pv1:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/pv1?flash=claimed&orderId=${orderId}`,
    failureRedirect: `/ops/pv1`,
    successLogEvent: "ops.pv1.start.applied",
    failureLogEvent: "ops.pv1.start.failed",
  });
}
