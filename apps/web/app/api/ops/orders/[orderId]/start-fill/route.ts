// POST /api/ops/orders/:orderId/start-fill
//
// Tech claims an order from the fill queue. Dispatches the
// standard `StartFill` command. RBAC enforced by the command
// (`fill.start` permission).

import { StartFill } from "@pharmax/fill";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: StartFill,
    idempotencyKeyPrefix: `route:start-fill:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/fill/${orderId}?flash=claimed`,
    failureRedirect: `/ops/fill`,
    successLogEvent: "ops.fill.start.applied",
    failureLogEvent: "ops.fill.start.failed",
  });
}
