// POST /api/ops/inventory/compound-batch-transition
//
// One route for the four compound-batch lifecycle actions, selected
// by the `action` field:
//
//   send_to_testing   → SendCompoundBatchToTesting  (COMPOUNDED → TESTING)
//   release           → ReleaseCompoundBatch        (TESTING → RELEASED)
//   reject            → RejectCompoundBatch         (TESTING → REJECTED)
//   start_dispensing  → StartDispensingCompoundBatch (RELEASED → DISPENSING)
//
// Each action dispatches its own command — RBAC (transition vs
// release permission), status guards, and reason-code requirements
// are all enforced by the commands, never here. The route only picks
// which command to dispatch and shapes the redirect.
//
// Catalog/inventory data only — no PHI in this route.

import {
  RejectCompoundBatch,
  ReleaseCompoundBatch,
  SendCompoundBatchToTesting,
  StartDispensingCompoundBatch,
  type CompoundBatchTransitionOutput,
  type RejectCompoundBatchInput,
  type ReleaseCompoundBatchInput,
  type SendCompoundBatchToTestingInput,
  type StartDispensingCompoundBatchInput,
} from "@pharmax/inventory";
import type { Command } from "@pharmax/command-bus";

import { dispatchOpsCommand } from "../../../../../src/server/ops/dispatch-from-route.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

const ACTION_LABELS = {
  send_to_testing: "sent to testing",
  release: "released",
  reject: "rejected",
  start_dispensing: "now dispensing",
} as const;

type TransitionAction = keyof typeof ACTION_LABELS;

function isTransitionAction(value: string): value is TransitionAction {
  return Object.hasOwn(ACTION_LABELS, value);
}

/** Read the action + batchId without consuming the request the
 *  dispatcher will parse for itself. An unparseable body leaves both
 *  empty and falls through to the unknown-action redirect. */
async function peekAction(request: Request): Promise<{ action: string; batchId: string }> {
  try {
    const form = await request.clone().formData();
    const action = form.get("action");
    const batchId = form.get("batchId");
    return {
      action: typeof action === "string" ? action : "",
      batchId: typeof batchId === "string" ? batchId : "",
    };
  } catch {
    try {
      const json = (await request.clone().json()) as Record<string, unknown>;
      return {
        action: typeof json["action"] === "string" ? json["action"] : "",
        batchId: typeof json["batchId"] === "string" ? json["batchId"] : "",
      };
    } catch {
      return { action: "", batchId: "" };
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  const { action, batchId } = await peekAction(request);
  const detailPath = `/ops/admin/compound-batches/${batchId}`;

  if (!isTransitionAction(action)) {
    const url = new URL(detailPath, request.url);
    url.searchParams.set("error", "Unknown batch action.");
    return Response.redirect(url.toString(), 303);
  }

  // Generic over the input type so each command is dispatched with
  // exactly the input its own buildInput produced — the four commands
  // share an output shape but not an input shape.
  const dispatch = <TIn>(
    command: Command<TIn, CompoundBatchTransitionOutput>,
    buildInput: (body: FormData | Record<string, unknown>) => TIn | { readonly error: string }
  ): Promise<Response> =>
    dispatchOpsCommand({
      request,
      command,
      idempotencyKeyPrefix: `route:compound-batch-transition:${action}`,
      buildInput: ({ body }) => buildInput(body),
      successRedirect: (output) =>
        `${detailPath}?flash=${encodeURIComponent(
          `Batch ${output.batchNumber} ${ACTION_LABELS[action]} (${output.fromStatus} → ${output.toStatus}).`
        )}`,
      failureRedirect: detailPath,
      successLogEvent: `ops.inventory.compound_batch.${action}.applied`,
      failureLogEvent: `ops.inventory.compound_batch.${action}.failed`,
    });

  switch (action) {
    case "send_to_testing":
      return await dispatch<SendCompoundBatchToTestingInput>(SendCompoundBatchToTesting, (body) => {
        const id = readString(body, "batchId");
        return id === null ? { error: "batchId is required." } : { batchId: id };
      });

    case "release":
      return await dispatch<ReleaseCompoundBatchInput>(ReleaseCompoundBatch, (body) => {
        const id = readString(body, "batchId");
        if (id === null) return { error: "batchId is required." };
        const labReference = readString(body, "labReference");
        return { batchId: id, ...(labReference !== null ? { labReference } : {}) };
      });

    case "reject":
      return await dispatch<RejectCompoundBatchInput>(RejectCompoundBatch, (body) => {
        const id = readString(body, "batchId");
        if (id === null) return { error: "batchId is required." };
        const reasonCode = readString(body, "reasonCode");
        if (reasonCode === null) return { error: "A rejection reason is required." };
        const note = readString(body, "note");
        // The reason code is validated against the reason list by the
        // command's Zod schema, not here.
        return {
          batchId: id,
          reasonCode,
          ...(note !== null ? { note } : {}),
        } as RejectCompoundBatchInput;
      });

    case "start_dispensing":
      return await dispatch<StartDispensingCompoundBatchInput>(
        StartDispensingCompoundBatch,
        (body) => {
          const id = readString(body, "batchId");
          return id === null ? { error: "batchId is required." } : { batchId: id };
        }
      );

    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled batch transition action: ${String(exhaustive)}`);
    }
  }
}
