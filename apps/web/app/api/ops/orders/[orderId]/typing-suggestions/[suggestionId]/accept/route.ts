// POST /api/ops/orders/:orderId/typing-suggestions/:suggestionId/accept
//
// The human gate. A suggestion becomes a prescription edit ONLY here,
// under a technician's identity — nothing in the AI path writes to a
// prescription on its own.
//
// `expectedOrderVersion` is REQUIRED, not defaulted: it is the
// optimistic-concurrency token proving the technician is acting on the
// order state they were shown. A defaulted or omitted version would
// silently accept advice about a row that has since moved, which is
// exactly the failure mode the command's stale-value check exists to
// prevent. The form that renders the proposal carries the version it
// read as a hidden field.
//
// RBAC enforced by the command (`ai.typing_suggestions.use`); the
// command additionally re-verifies order state, suggestion status,
// the recorded before-value, and the LIVE guardrail ceilings.

import { AcceptTypingSuggestion } from "@pharmax/typing-assist";

import { dispatchOpsCommand } from "../../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string; readonly suggestionId: string }>;
}

function readInt(body: FormData | Record<string, unknown>, key: string): number | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId, suggestionId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: AcceptTypingSuggestion,
    idempotencyKeyPrefix: `route:accept-typing-suggestion:${orderId}:${suggestionId}`,
    buildInput: ({ body }) => {
      const expectedOrderVersion = readInt(body, "expectedOrderVersion");
      if (expectedOrderVersion === null || expectedOrderVersion < 0) {
        return { error: "expectedOrderVersion is required and must be a non-negative integer." };
      }
      return { orderId, suggestionId, expectedOrderVersion };
    },
    successRedirect: (output) =>
      `/ops/typing?flash=suggestion_accepted&orderId=${orderId}&field=${output.field}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.suggestions.accept.applied",
    failureLogEvent: "ops.typing.suggestions.accept.failed",
  });
}
