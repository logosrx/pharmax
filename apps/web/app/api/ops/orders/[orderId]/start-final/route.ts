// POST /api/ops/orders/:orderId/start-final
//
// Pharmacist claims an order from the final-verification queue.
// Dispatches the standard `StartFinalVerification` command. RBAC
// enforced by the command (`final.start` permission).

import { StartFinalVerification } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: StartFinalVerification,
    idempotencyKeyPrefix: `route:start-final:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/final?flash=claimed&orderId=${orderId}`,
    failureRedirect: `/ops/final`,
    successLogEvent: "ops.final.start.applied",
    failureLogEvent: "ops.final.start.failed",
  });
}
