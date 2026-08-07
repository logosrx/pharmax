// POST /api/ops/orders/:orderId/approve-pv1
//
// Pharmacist approves PV1 → order transitions to
// PV1_APPROVED_READY_FOR_FILL and moves to the FILL bucket.
// Dispatches the standard `ApprovePV1` command. RBAC enforced by
// the command (`pv1.approve` permission); the command also runs
// the segregation-of-duties check so the typist who handled this
// order cannot also approve PV1.
//
// TWO CALLERS, TWO CONTRACTS. The PV1 queue posts a bare approve —
// no fields — and a failure sends the pharmacist to the queue banner
// that links them to the order. The ORDER DETAIL page posts
// `from=detail` plus `reviewedScreenDigest`: the digest the page
// computed over the findings panel it rendered, which the command
// compares against its sign-off re-screen and refuses on ANY
// difference (`PV1_SCREENING_CHANGED_SINCE_REVIEW`). A failure from
// that caller lands back on the detail page itself, where the
// refusal banner sits beside the findings panel it is about.

import { ApprovePV1, SCREEN_DIGEST_PATTERN } from "@pharmax/verification";

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

  // Failure target depends on which surface posted — resolved during
  // `buildInput`, read by the thunk at redirect time (the documented
  // `failureRedirect` thunk contract in `dispatch-from-route.ts`).
  // Carrying the order lets the queue's screening-refusal banner point
  // at the findings panel rather than showing a code with no
  // destination.
  let failureTarget = `/ops/pv1?orderId=${orderId}`;

  return await dispatchOpsCommand({
    request,
    command: ApprovePV1,
    idempotencyKeyPrefix: `route:approve-pv1:${orderId}`,
    buildInput: ({ body }) => {
      if (readString(body, "from") === "detail") {
        failureTarget = `/ops/orders/${orderId}`;
      }
      const reviewedScreenDigest = readString(body, "reviewedScreenDigest");
      if (reviewedScreenDigest === null) {
        return { orderId };
      }
      if (!SCREEN_DIGEST_PATTERN.test(reviewedScreenDigest)) {
        // A malformed digest is a broken form, not a stale review —
        // refuse before a command is dispatched rather than let it
        // fail schema validation dressed as a screening refusal.
        return { error: "reviewedScreenDigest must be a hex SHA-256 digest." };
      }
      return { orderId, reviewedScreenDigest };
    },
    successRedirect: () => `/ops/pv1?flash=approved&orderId=${orderId}`,
    failureRedirect: () => failureTarget,
    successLogEvent: "ops.pv1.approve.applied",
    failureLogEvent: "ops.pv1.approve.failed",
  });
}
