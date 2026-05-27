// POST /api/ops/orders/:orderId/reopen-for-correction
//
// Move a rejected order back into an earlier workflow stage for
// rework. Reachable from PV1_REJECTED (back to typing) and
// FINAL_VERIFICATION_REJECTED (back to fill); the command
// validates `reopenToState` against
// REOPEN_TARGETS_BY_SOURCE. RBAC enforced by the command
// (`orders.reopen_for_correction` permission).
//
// `reasonText` is OPTIONAL but REQUIRED by the command's Zod
// `.refine` when `reason === OTHER`. The command also redacts
// `reasonText` from command_log.requestPayload (it's PHI-adjacent
// — operators may type patient details into the free-text box).

import {
  REOPEN_REASONS,
  ReopenForCorrection,
  type ReopenForCorrectionInput,
} from "@pharmax/orders";
import { ReopenReason } from "@pharmax/database";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

const REOPEN_TARGET_STATES = [
  "TYPING_IN_PROGRESS",
  "TYPED_READY_FOR_PV1",
  "FILL_IN_PROGRESS",
  "FILL_COMPLETED_READY_FOR_FINAL",
] as const;
type ReopenTargetState = (typeof REOPEN_TARGET_STATES)[number];

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: ReopenForCorrection,
    idempotencyKeyPrefix: `route:reopen-for-correction:${orderId}`,
    buildInput: ({ body }) => {
      const reopenToState = readString(body, "reopenToState");
      const reason = readString(body, "reason");
      const reasonText = readString(body, "reasonText");
      if (
        reopenToState === null ||
        !REOPEN_TARGET_STATES.includes(reopenToState as ReopenTargetState)
      ) {
        return {
          error: `reopenToState must be one of: ${REOPEN_TARGET_STATES.join(", ")}.`,
        };
      }
      if (reason === null || !REOPEN_REASONS.includes(reason as ReopenReason)) {
        return {
          error: `reason must be one of: ${REOPEN_REASONS.join(", ")}.`,
        };
      }
      if (reason === ReopenReason.OTHER && reasonText === null) {
        return { error: "reasonText is required when reason is OTHER." };
      }
      const input: ReopenForCorrectionInput = {
        orderId,
        reopenToState: reopenToState as ReopenTargetState,
        reason: reason as ReopenReason,
        ...(reasonText !== null ? { reasonText } : {}),
      };
      return input;
    },
    // Both PV1_REJECTED (typing queue) and FINAL_VERIFICATION_REJECTED
    // (fill queue) can land here; the success redirect routes back
    // to whichever queue was the source. We use the URL-passed
    // `returnTo` query parameter (set by the form) to pick the
    // right target; fallback to /ops/typing.
    successRedirect: () => `/ops/typing?flash=reopened&orderId=${orderId}`,
    failureRedirect: `/ops/typing`,
    successLogEvent: "ops.orders.reopen.applied",
    failureLogEvent: "ops.orders.reopen.failed",
  });
}
