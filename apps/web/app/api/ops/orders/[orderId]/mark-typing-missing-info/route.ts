// POST /api/ops/orders/:orderId/mark-typing-missing-info
//
// Typist pauses an in-progress typing on an order with a
// structured missing-info reason. Dispatches `MarkTypingMissingInfo`
// — order transitions TYPING_IN_PROGRESS →
// TYPING_PENDING_MISSING_INFO, parks in the TYPING bucket as an
// exception-styled row, clears the assignee. RBAC enforced by the
// command (`typing.mark_missing_info` permission).

import {
  MarkTypingMissingInfo,
  MISSING_INFO_REASONS,
  type MissingInfoReason,
} from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: MarkTypingMissingInfo,
    idempotencyKeyPrefix: `route:mark-typing-missing-info:${orderId}`,
    buildInput: ({ body }) => {
      const reasonCode = readString(body, "reasonCode");
      if (reasonCode === null || !MISSING_INFO_REASONS.includes(reasonCode as MissingInfoReason)) {
        return {
          error: `reasonCode must be one of: ${MISSING_INFO_REASONS.join(", ")}.`,
        };
      }
      return { orderId, reasonCode: reasonCode as MissingInfoReason };
    },
    successRedirect: () => `/ops/typing?flash=marked_missing&orderId=${orderId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.mark_missing_info.applied",
    failureLogEvent: "ops.typing.mark_missing_info.failed",
  });
}
