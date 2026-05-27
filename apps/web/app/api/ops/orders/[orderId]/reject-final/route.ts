// POST /api/ops/orders/:orderId/reject-final
//
// Pharmacist rejects final verification with a structured reason
// code. Order transitions to FINAL_VERIFICATION_REJECTED and
// routes back to the FILL bucket for rework. Dispatches the
// standard `RejectFinalVerification` command. RBAC enforced by
// the command (`final.reject` permission).

import {
  FINAL_REJECTION_REASONS,
  RejectFinalVerification,
  type FinalRejectionReason,
} from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  if (body instanceof FormData) {
    const v = body.get(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: RejectFinalVerification,
    idempotencyKeyPrefix: `route:reject-final:${orderId}`,
    buildInput: ({ body }) => {
      const reasonCode = readString(body, "reasonCode");
      if (
        reasonCode === null ||
        !FINAL_REJECTION_REASONS.includes(reasonCode as FinalRejectionReason)
      ) {
        return {
          error: `reasonCode must be one of: ${FINAL_REJECTION_REASONS.join(", ")}.`,
        };
      }
      return { orderId, reasonCode: reasonCode as FinalRejectionReason };
    },
    successRedirect: () => `/ops/final?flash=rejected&orderId=${orderId}`,
    failureRedirect: `/ops/final`,
    successLogEvent: "ops.final.reject.applied",
    failureLogEvent: "ops.final.reject.failed",
  });
}
