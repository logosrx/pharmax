// POST /api/ops/orders/:orderId/typing-suggestions/:suggestionId/dismiss
//
// The technician rejects a proposal. `dismissReasonCode` is required
// from a closed vocabulary — a dismissal with no reason tells us
// nothing, while these four codes distinguish "the model was wrong"
// from "the model was right and I fixed it another way", which is the
// signal that makes the suggestion quality report worth reading.
//
// Nothing about the prescription or the order changes here (no version
// bump); only the suggestion row is resolved. RBAC enforced by the
// command (`ai.typing_suggestions.use`).

import {
  DismissTypingSuggestion,
  TYPING_SUGGESTION_DISMISS_REASONS,
  type TypingSuggestionDismissReason,
} from "@pharmax/typing-assist";

import { dispatchOpsCommand } from "../../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string; readonly suggestionId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId, suggestionId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: DismissTypingSuggestion,
    idempotencyKeyPrefix: `route:dismiss-typing-suggestion:${orderId}:${suggestionId}`,
    buildInput: ({ body }) => {
      const dismissReasonCode = readString(body, "dismissReasonCode");
      if (
        dismissReasonCode === null ||
        !TYPING_SUGGESTION_DISMISS_REASONS.includes(
          dismissReasonCode as TypingSuggestionDismissReason
        )
      ) {
        return {
          error: `dismissReasonCode must be one of: ${TYPING_SUGGESTION_DISMISS_REASONS.join(", ")}.`,
        };
      }
      return {
        orderId,
        suggestionId,
        dismissReasonCode: dismissReasonCode as TypingSuggestionDismissReason,
      };
    },
    successRedirect: () => `/ops/typing?flash=suggestion_dismissed&orderId=${orderId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.suggestions.dismiss.applied",
    failureLogEvent: "ops.typing.suggestions.dismiss.failed",
  });
}
