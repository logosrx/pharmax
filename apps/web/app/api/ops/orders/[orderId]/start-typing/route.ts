// POST /api/ops/orders/:orderId/start-typing
//
// Typist claims a RECEIVED order from the inbox. Dispatches the
// standard `StartTyping` command. Order transitions RECEIVED →
// TYPING_IN_PROGRESS and moves from INBOX → TYPING bucket. RBAC
// enforced by the command (`typing.start` permission).

import { StartTyping } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: StartTyping,
    idempotencyKeyPrefix: `route:start-typing:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/typing?flash=claimed&orderId=${orderId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.start.applied",
    failureLogEvent: "ops.typing.start.failed",
  });
}
