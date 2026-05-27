// POST /api/ops/orders/:orderId/resume-typing
//
// Typist resumes work on an order that was paused via
// MarkTypingMissingInfo. Dispatches `ResumeTyping` — order
// transitions TYPING_PENDING_MISSING_INFO → TYPING_IN_PROGRESS,
// stays on the TYPING bucket, assignee set to the resuming
// typist. RBAC enforced by the command (`typing.start` permission
// — structurally the same gate as the inbox-claim action).

import { ResumeTyping } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: ResumeTyping,
    idempotencyKeyPrefix: `route:resume-typing:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/typing?flash=resumed&orderId=${orderId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.resume.applied",
    failureLogEvent: "ops.typing.resume.failed",
  });
}
