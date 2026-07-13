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

/**
 * Which queue page owns each reopen target. A PV1 bounce-back
 * reopens INTO typing states (typing queue); a final-verification
 * bounce-back reopens INTO fill states (fill queue). The operator
 * must land back on the queue they were working, not always typing.
 */
function queueForReopenTarget(state: ReopenTargetState): "/ops/typing" | "/ops/fill" {
  switch (state) {
    case "TYPING_IN_PROGRESS":
    case "TYPED_READY_FOR_PV1":
      return "/ops/typing";
    case "FILL_IN_PROGRESS":
    case "FILL_COMPLETED_READY_FOR_FINAL":
      return "/ops/fill";
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled reopen target state: ${String(exhaustive)}`);
    }
  }
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  // Captured during buildInput so BOTH redirects (success uses the
  // command output; failure has no output) can route back to the
  // source queue. Defaults to typing for requests that fail before
  // buildInput resolves a valid target.
  let sourceQueue: "/ops/typing" | "/ops/fill" = "/ops/typing";
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
      sourceQueue = queueForReopenTarget(reopenToState as ReopenTargetState);
      const input: ReopenForCorrectionInput = {
        orderId,
        reopenToState: reopenToState as ReopenTargetState,
        reason: reason as ReopenReason,
        ...(reasonText !== null ? { reasonText } : {}),
      };
      return input;
    },
    // Both PV1_REJECTED (typing queue) and FINAL_VERIFICATION_REJECTED
    // (fill queue) land here. Route back to the queue that OWNS the
    // reopen target — a fill tech reopening a final-verification
    // rejection must land back on /ops/fill, not typing.
    successRedirect: () => `${sourceQueue}?flash=reopened&orderId=${orderId}`,
    failureRedirect: () => sourceQueue,
    successLogEvent: "ops.orders.reopen.applied",
    failureLogEvent: "ops.orders.reopen.failed",
  });
}
