// DismissTypingSuggestion — a technician declines a proposal.
//
// Every rejection carries a reason code (workflow-safety rule), and
// the reasons are a CLOSED vocabulary because they feed the model's
// report card: "dismissed as wrong" and "dismissed because I already
// fixed it by hand" are opposite signals about suggestion quality, and
// free text cannot be aggregated into either. The dismissal is a
// domain record with an actor stamp, an audit row, and an outbox
// event — a proposal a human looked at and declined is evidence, both
// for tuning thresholds and for the auditor asking what the AI was
// allowed to influence.
//
// The order row is locked and must still be in TYPING_IN_PROGRESS:
// dismissals are part of the same review loop as accepts, and letting
// them land after typing completes would let the suggestion ledger
// change shape outside the stage PV1 audits. No version bump — a
// dismissal changes no clinical content.
//
// PHI invariant: ids, the field name, the reason code. No values.

import { defineCommand } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  TYPING_SUGGESTION_NOT_FOUND,
  TYPING_SUGGESTION_NOT_PROPOSED,
  TYPING_SUGGESTION_ORDER_NOT_IN_TYPING,
} from "./accept-typing-suggestion.js";

// ---------------------------------------------------------------------------
// Dismiss reasons — closed vocabulary, exported for the UI.
// ---------------------------------------------------------------------------

export const TYPING_SUGGESTION_DISMISS_REASONS = [
  // The proposal is wrong: the typed value matches the source document.
  "SOURCE_DOCUMENT_CONFIRMS_TYPED_VALUE",
  // The proposal is right about the problem, wrong about the fix; the
  // technician corrected the field by hand instead.
  "FIXED_MANUALLY_DIFFERENT_VALUE",
  // The flagged situation is intentional (prescriber-confirmed
  // exception, clinic-specific convention).
  "INTENTIONAL_AS_PRESCRIBED",
  // Escalated instead: missing-info loop, pharmacist consult.
  "ESCALATED_FOR_CLARIFICATION",
] as const;

export type TypingSuggestionDismissReason = (typeof TYPING_SUGGESTION_DISMISS_REASONS)[number];

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    suggestionId: z.uuid(),
    dismissReasonCode: z.enum(TYPING_SUGGESTION_DISMISS_REASONS),
  })
  .strict();

export type DismissTypingSuggestionInput = z.infer<typeof inputSchema>;

export interface DismissTypingSuggestionOutput {
  readonly suggestionId: string;
  readonly dismissReasonCode: TypingSuggestionDismissReason;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const DismissTypingSuggestion = defineCommand<
  DismissTypingSuggestionInput,
  DismissTypingSuggestionOutput
>({
  name: "DismissTypingSuggestion",
  inputSchema,
  permission: PERMISSIONS.AI_TYPING_SUGGESTIONS_USE,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: [],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "DISMISS_TYPING_SUGGESTION_NO_TARGET",
        message: "Locked order target was not provided to DismissTypingSuggestion.",
      });
    }

    const orgId = ctx.organizationId;

    if (target.currentStatus !== OrderStatus.TYPING_IN_PROGRESS) {
      throw new errors.ConflictError({
        code: TYPING_SUGGESTION_ORDER_NOT_IN_TYPING,
        message: `Order is in state ${target.currentStatus}; suggestions can only be dismissed while typing is in progress.`,
        metadata: { orderId: target.id, currentStatus: target.currentStatus },
      });
    }

    const suggestion = await tx.typingSuggestion.findFirst({
      where: { id: input.suggestionId, organizationId: orgId, orderId: target.id },
      select: {
        id: true,
        prescriptionId: true,
        runId: true,
        source: true,
        findingCode: true,
        field: true,
        confidencePercent: true,
        status: true,
      },
    });
    if (suggestion === null) {
      throw new errors.NotFoundError({
        code: TYPING_SUGGESTION_NOT_FOUND,
        message: "Suggestion does not exist on this order.",
        metadata: { suggestionId: input.suggestionId, orderId: target.id },
      });
    }
    if (suggestion.status !== "PROPOSED") {
      throw new errors.ConflictError({
        code: TYPING_SUGGESTION_NOT_PROPOSED,
        message: `Suggestion is ${suggestion.status}; only PROPOSED suggestions can be dismissed.`,
        metadata: { suggestionId: suggestion.id, status: suggestion.status },
      });
    }

    const now = clock.now();

    await tx.typingSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "DISMISSED",
        dismissReasonCode: input.dismissReasonCode,
        resolvedByUserId: ctx.actor.userId,
        resolvedAt: now,
      },
    });

    return {
      output: {
        suggestionId: suggestion.id,
        dismissReasonCode: input.dismissReasonCode,
      },
      targetOrderId: target.id,
      audit: {
        action: "ai.typing_suggestion.dismissed",
        resourceType: "TypingSuggestion",
        resourceId: suggestion.id,
        metadata: {
          suggestionId: suggestion.id,
          runId: suggestion.runId,
          orderId: target.id,
          prescriptionId: suggestion.prescriptionId,
          source: suggestion.source,
          findingCode: suggestion.findingCode,
          field: suggestion.field,
          confidencePercent: suggestion.confidencePercent,
          dismissReasonCode: input.dismissReasonCode,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "ai.typing_suggestion.dismissed.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            suggestionId: suggestion.id,
            runId: suggestion.runId,
            organizationId: orgId,
            orderId: target.id,
            prescriptionId: suggestion.prescriptionId,
            source: suggestion.source,
            field: suggestion.field,
            dismissReasonCode: input.dismissReasonCode,
            dismissedByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
