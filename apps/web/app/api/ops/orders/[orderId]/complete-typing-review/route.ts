// POST /api/ops/orders/:orderId/complete-typing-review
//
// Typist completes typing and routes the order to PV1. Dispatches
// the standard `CompleteTypingReview` command. Order transitions
// TYPING_IN_PROGRESS → TYPED_READY_FOR_PV1 and moves from TYPING
// → PV1 bucket. RBAC enforced by the command (`typing.complete`
// permission). Same-actor Separation-of-Duties is enforced on the
// downstream PV1 approval (the typist cannot ALSO be the PV1
// pharmacist), not here.

import { CompleteTypingReview } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: CompleteTypingReview,
    idempotencyKeyPrefix: `route:complete-typing-review:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/typing?flash=completed&orderId=${orderId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.complete.applied",
    failureLogEvent: "ops.typing.complete.failed",
  });
}
