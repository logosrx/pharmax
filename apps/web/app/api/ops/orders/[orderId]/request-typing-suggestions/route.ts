// POST /api/ops/orders/:orderId/request-typing-suggestions
//
// Typist asks for an AI review of the prescription they are typing.
// Dispatches `RequestTypingSuggestions`: the deterministic findings
// are turned into concrete proposals synchronously, and — when the
// org's AI-assist policy and the product's guardrail both permit it —
// an `ai.typing_suggestion_run.requested.v1` event schedules the
// model stage in the worker.
//
// Not a workflow transition: the order status and version are
// untouched, so requesting a review can never CAS-conflict a
// colleague's real edit. RBAC enforced by the command
// (`ai.typing_suggestions.use`).

import { RequestTypingSuggestions } from "@pharmax/typing-assist";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function readUuid(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  // Server-side shape only — Zod re-validates inside the command.
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: RequestTypingSuggestions,
    idempotencyKeyPrefix: `route:request-typing-suggestions:${orderId}`,
    buildInput: ({ body }) => {
      const prescriptionId = readUuid(body, "prescriptionId");
      if (prescriptionId === null) return { error: "prescriptionId is required." };
      return { orderId, prescriptionId };
    },
    // The run id is the technician's handle on this review — the
    // panel polls it while the model stage settles.
    successRedirect: (output) =>
      `/ops/typing?flash=review_requested&orderId=${orderId}&runId=${output.runId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.typing.suggestions.request.applied",
    failureLogEvent: "ops.typing.suggestions.request.failed",
  });
}
