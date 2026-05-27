// POST /api/ops/orders/:orderId/approve-final
//
// Second-pharmacist signature: releases the order to the SHIPPING
// bucket. The command bus enforces Separation-of-Duties — an
// approval by the SAME pharmacist who performed PV1 on this order
// fails with a typed SoD error, which surfaces back to the queue
// page as a flash error.

import { ApproveFinalVerification } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: ApproveFinalVerification,
    idempotencyKeyPrefix: `route:approve-final:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/final?flash=approved&orderId=${orderId}`,
    failureRedirect: `/ops/final`,
    successLogEvent: "ops.final.approve.applied",
    failureLogEvent: "ops.final.approve.failed",
  });
}
