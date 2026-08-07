// POST /api/ops/orders/:orderId/reject-pv1
//
// Pharmacist rejects PV1 with a structured reason code. Order
// transitions to PV1_REJECTED and routes back to the TYPING bucket
// for rework (per `BUCKET_CODE_FOR_EXCEPTION_STATE`). Dispatches
// the standard `RejectPV1` command. RBAC enforced by the command
// (`pv1.reject` permission).

import { PV1_REJECTION_REASONS, RejectPV1, type PV1RejectionReason } from "@pharmax/verification";

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

  // The order detail page posts `from=detail`; a failure should land
  // back beside the prescription being rejected, not on the queue.
  // Resolved during `buildInput`, read by the thunk at redirect time.
  let failureTarget = `/ops/pv1`;

  return await dispatchOpsCommand({
    request,
    command: RejectPV1,
    idempotencyKeyPrefix: `route:reject-pv1:${orderId}`,
    buildInput: ({ body }) => {
      if (readString(body, "from") === "detail") {
        failureTarget = `/ops/orders/${orderId}`;
      }
      const reasonCode = readString(body, "reasonCode");
      if (
        reasonCode === null ||
        !PV1_REJECTION_REASONS.includes(reasonCode as PV1RejectionReason)
      ) {
        return {
          error: `reasonCode must be one of: ${PV1_REJECTION_REASONS.join(", ")}.`,
        };
      }
      return { orderId, reasonCode: reasonCode as PV1RejectionReason };
    },
    successRedirect: () => `/ops/pv1?flash=rejected&orderId=${orderId}`,
    failureRedirect: () => failureTarget,
    successLogEvent: "ops.pv1.reject.applied",
    failureLogEvent: "ops.pv1.reject.failed",
  });
}
