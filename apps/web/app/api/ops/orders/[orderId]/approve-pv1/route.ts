// POST /api/ops/orders/:orderId/approve-pv1
//
// Pharmacist approves PV1 → order transitions to
// PV1_APPROVED_READY_FOR_FILL and moves to the FILL bucket.
// Dispatches the standard `ApprovePV1` command. RBAC enforced by
// the command (`pv1.approve` permission); the command also runs
// the segregation-of-duties check so the typist who handled this
// order cannot also approve PV1.

import { ApprovePV1 } from "@pharmax/verification";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: ApprovePV1,
    idempotencyKeyPrefix: `route:approve-pv1:${orderId}`,
    buildInput: () => ({ orderId }),
    successRedirect: () => `/ops/pv1?flash=approved&orderId=${orderId}`,
    failureRedirect: `/ops/pv1`,
    successLogEvent: "ops.pv1.approve.applied",
    failureLogEvent: "ops.pv1.approve.failed",
  });
}
