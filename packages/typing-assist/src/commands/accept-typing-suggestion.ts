// AcceptTypingSuggestion — the ONLY write path from a suggestion to a
// prescription row. "A model may propose; only a human may accept" is
// enforced here: the actor is a technician with the typing-assist
// grant, the order row is locked, and every safety property the
// proposal claimed at generation time is RE-verified against the live
// rows before the write:
//
//   1. Order still TYPING_IN_PROGRESS (the stage whose audit shape
//      covers prescription edits).
//   2. Suggestion still PROPOSED and belongs to this order + org.
//   3. Stale-value check: the prescription field still holds the value
//      the suggestion recorded as `currentValue`. If a colleague (or
//      an earlier accept) changed it, the suggestion is refused with a
//      stable code — accepting advice about a row that moved is how
//      "AI assist" becomes "AI overwrite".
//   4. Vocabulary re-parse of `suggestedValue` (defense in depth
//      against a row edited outside the command surface).
//   5. Guardrail ceilings re-checked against the LIVE guardrail row,
//      not the run's snapshot — a tenant who tightened a ceiling after
//      the proposal was generated wins.
//
// The write updates exactly ONE field, bumps the order version (PV1
// reads prescriptions; a concurrent CompleteTypingReview must CAS-
// conflict rather than carry a stale read forward), marks the
// suggestion ACCEPTED with the actor stamp + this command_log id, and
// supersedes any sibling PROPOSED suggestions for the same field.
//
// PHI invariant: every acceptable field is structured non-PHI by
// vocabulary construction, so before/after values may appear in audit
// metadata and the outbox payload.

import { defineCommand } from "@pharmax/command-bus";
import { OrderStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  isTypingSuggestionField,
  parseSuggestionValue,
  type TypingSuggestionField,
} from "../suggestions/fields.js";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
// ---------------------------------------------------------------------------

export const TYPING_SUGGESTION_NOT_FOUND = "TYPING_SUGGESTION_NOT_FOUND";
export const TYPING_SUGGESTION_NOT_PROPOSED = "TYPING_SUGGESTION_NOT_PROPOSED";
export const TYPING_SUGGESTION_STALE = "TYPING_SUGGESTION_STALE";
export const TYPING_SUGGESTION_ORDER_NOT_IN_TYPING = "TYPING_SUGGESTION_ORDER_NOT_IN_TYPING";
export const TYPING_SUGGESTION_VALUE_INVALID = "TYPING_SUGGESTION_VALUE_INVALID";
export const TYPING_SUGGESTION_GUARDRAIL_BREACH = "TYPING_SUGGESTION_GUARDRAIL_BREACH";

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    suggestionId: z.uuid(),
    /** Optimistic-concurrency: the caller's view of the order version. */
    expectedOrderVersion: z.int().nonnegative(),
  })
  .strict();

export type AcceptTypingSuggestionInput = z.infer<typeof inputSchema>;

export interface AcceptTypingSuggestionOutput {
  readonly suggestionId: string;
  readonly prescriptionId: string;
  readonly field: TypingSuggestionField;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly supersededSiblingCount: number;
}

// ---------------------------------------------------------------------------
// Field → prescription column write
// ---------------------------------------------------------------------------

/** Current live value of the target field, normalized to the same
 *  JSON-scalar space `typing_suggestion.currentValue` uses. */
function liveValueForField(
  field: TypingSuggestionField,
  row: {
    readonly quantityAuthorized: Prisma.Decimal;
    readonly daysSupply: number;
    readonly refillsAuthorized: number;
    readonly refillsRemaining: number;
    readonly daw: number;
    readonly expiresAt: Date;
    readonly earliestFillDate: Date | null;
    readonly controlledSubstanceSchedule: string;
    readonly sigStructureKind: string | null;
    readonly doseAmount: Prisma.Decimal | null;
    readonly doseUnit: string | null;
    readonly dosesPerDay: Prisma.Decimal | null;
    readonly drugStrength: string | null;
    readonly drugForm: string | null;
  }
): unknown {
  switch (field) {
    case "quantityAuthorized":
      return Number(row.quantityAuthorized);
    case "daysSupply":
      return row.daysSupply;
    case "refillsAuthorized":
      return row.refillsAuthorized;
    case "refillsRemaining":
      return row.refillsRemaining;
    case "daw":
      return row.daw;
    case "expiresAt":
      return row.expiresAt.toISOString().slice(0, 10);
    case "earliestFillDate":
      return row.earliestFillDate === null ? null : row.earliestFillDate.toISOString().slice(0, 10);
    case "controlledSubstanceSchedule":
      return row.controlledSubstanceSchedule;
    case "sigStructureKind":
      return row.sigStructureKind;
    case "doseAmount":
      return row.doseAmount === null ? null : Number(row.doseAmount);
    case "doseUnit":
      return row.doseUnit;
    case "dosesPerDay":
      return row.dosesPerDay === null ? null : Number(row.dosesPerDay);
    case "drugStrength":
      return row.drugStrength;
    case "drugForm":
      return row.drugForm;
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

/** Prisma update payload for one (field, parsedValue) pair. */
function prescriptionUpdateFor(
  field: TypingSuggestionField,
  value: unknown
): Prisma.PrescriptionUpdateInput {
  switch (field) {
    case "quantityAuthorized":
      return { quantityAuthorized: new Prisma.Decimal(value as number) };
    case "daysSupply":
      return { daysSupply: value as number };
    case "refillsAuthorized":
      return { refillsAuthorized: value as number };
    case "refillsRemaining":
      return { refillsRemaining: value as number };
    case "daw":
      return { daw: value as number };
    case "expiresAt":
      return { expiresAt: new Date(`${value as string}T00:00:00.000Z`) };
    case "earliestFillDate":
      return {
        earliestFillDate: value === null ? null : new Date(`${value as string}T00:00:00.000Z`),
      };
    case "controlledSubstanceSchedule":
      return { controlledSubstanceSchedule: value as never };
    case "sigStructureKind":
      return { sigStructureKind: value as never };
    case "doseAmount":
      return { doseAmount: value === null ? null : new Prisma.Decimal(value as number) };
    case "doseUnit":
      return { doseUnit: value as never };
    case "dosesPerDay":
      return { dosesPerDay: value === null ? null : new Prisma.Decimal(value as number) };
    case "drugStrength":
      return { drugStrength: value as string | null };
    case "drugForm":
      return { drugForm: value as string | null };
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const AcceptTypingSuggestion = defineCommand<
  AcceptTypingSuggestionInput,
  AcceptTypingSuggestionOutput
>({
  name: "AcceptTypingSuggestion",
  inputSchema,
  permission: PERMISSIONS.AI_TYPING_SUGGESTIONS_USE,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: [],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "ACCEPT_TYPING_SUGGESTION_NO_TARGET",
        message: "Locked order target was not provided to AcceptTypingSuggestion.",
      });
    }

    const orgId = ctx.organizationId;

    // ---- Step 1: state guard ----
    if (target.currentStatus !== OrderStatus.TYPING_IN_PROGRESS) {
      throw new errors.ConflictError({
        code: TYPING_SUGGESTION_ORDER_NOT_IN_TYPING,
        message: `Order is in state ${target.currentStatus}; suggestions can only be accepted while typing is in progress.`,
        metadata: { orderId: target.id, currentStatus: target.currentStatus },
      });
    }

    // ---- Step 2: optimistic-concurrency pre-flight ----
    if (target.version !== input.expectedOrderVersion) {
      throw new errors.ConflictError({
        code: "ORDER_VERSION_MISMATCH",
        message:
          "Order was modified by another command between your read and this submission. Refetch and retry.",
        metadata: {
          orderId: target.id,
          expectedVersion: input.expectedOrderVersion,
          actualVersion: target.version,
        },
      });
    }

    // ---- Step 3: load + validate the suggestion ----
    const suggestion = await tx.typingSuggestion.findFirst({
      where: { id: input.suggestionId, organizationId: orgId, orderId: target.id },
      select: {
        id: true,
        prescriptionId: true,
        runId: true,
        source: true,
        findingCode: true,
        field: true,
        currentValue: true,
        suggestedValue: true,
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
        message: `Suggestion is ${suggestion.status}; only PROPOSED suggestions can be accepted.`,
        metadata: { suggestionId: suggestion.id, status: suggestion.status },
      });
    }
    if (!isTypingSuggestionField(suggestion.field)) {
      throw new errors.InternalError({
        code: TYPING_SUGGESTION_VALUE_INVALID,
        message: "Suggestion targets a field outside the vocabulary.",
        metadata: { suggestionId: suggestion.id, field: suggestion.field },
      });
    }
    const field: TypingSuggestionField = suggestion.field;

    // Both columns are written as JSON null (never SQL NULL) when the
    // value is null — see `toSuggestionJsonInput` — so a null read here
    // means "the recorded value was null", not "nothing was recorded".
    const suggestedValue = suggestion.suggestedValue ?? null;
    const recordedCurrentValue = suggestion.currentValue ?? null;

    // ---- Step 4: vocabulary re-parse ----
    const parsed = parseSuggestionValue(field, suggestedValue);
    if (!parsed.ok) {
      throw new errors.InternalError({
        code: TYPING_SUGGESTION_VALUE_INVALID,
        message: `Stored suggestion value no longer parses: ${parsed.reason}`,
        metadata: { suggestionId: suggestion.id, field },
      });
    }

    // ---- Step 5: stale-value check against the LIVE row ----
    const prescription = await tx.prescription.findFirst({
      where: { id: suggestion.prescriptionId, organizationId: orgId },
      select: {
        id: true,
        drugNdc: true,
        quantityAuthorized: true,
        daysSupply: true,
        refillsAuthorized: true,
        refillsRemaining: true,
        daw: true,
        expiresAt: true,
        earliestFillDate: true,
        controlledSubstanceSchedule: true,
        sigStructureKind: true,
        doseAmount: true,
        doseUnit: true,
        dosesPerDay: true,
        drugStrength: true,
        drugForm: true,
      },
    });
    if (prescription === null) {
      throw new errors.InternalError({
        code: "ACCEPT_TYPING_SUGGESTION_PRESCRIPTION_VANISHED",
        message: "Prescription row is missing for an existing suggestion.",
        metadata: { prescriptionId: suggestion.prescriptionId },
      });
    }

    const liveValue = liveValueForField(field, prescription);
    if (JSON.stringify(liveValue) !== JSON.stringify(recordedCurrentValue)) {
      throw new errors.ConflictError({
        code: TYPING_SUGGESTION_STALE,
        message:
          "The prescription field changed after this suggestion was generated. Request a fresh run.",
        metadata: {
          suggestionId: suggestion.id,
          field,
          valueAtProposal: recordedCurrentValue,
          valueNow: liveValue,
        },
      });
    }

    // ---- Step 6: live guardrail re-check ----
    if (typeof parsed.value === "number") {
      const product = await tx.product.findFirst({
        where: { organizationId: orgId, ndc: prescription.drugNdc },
        select: { id: true },
      });
      const liveGuardrail =
        product === null
          ? null
          : await tx.productAiGuardrail.findFirst({
              where: { organizationId: orgId, productId: product.id },
              select: {
                maxQuantityPerFill: true,
                maxDaysSupplyPerFill: true,
                maxRefillsAuthorized: true,
                version: true,
              },
            });
      if (liveGuardrail !== null) {
        const breaches: Array<{ ceiling: number | null; applies: boolean }> = [
          {
            ceiling:
              liveGuardrail.maxQuantityPerFill === null
                ? null
                : Number(liveGuardrail.maxQuantityPerFill),
            applies: field === "quantityAuthorized",
          },
          {
            ceiling: liveGuardrail.maxDaysSupplyPerFill,
            applies: field === "daysSupply",
          },
          {
            ceiling: liveGuardrail.maxRefillsAuthorized,
            applies: field === "refillsAuthorized" || field === "refillsRemaining",
          },
        ];
        for (const b of breaches) {
          if (b.applies && b.ceiling !== null && parsed.value > b.ceiling) {
            throw new errors.ConflictError({
              code: TYPING_SUGGESTION_GUARDRAIL_BREACH,
              message:
                "Accepting this suggestion would breach the product's live guardrail ceiling.",
              metadata: {
                suggestionId: suggestion.id,
                field,
                proposedValue: parsed.value,
                ceiling: b.ceiling,
                guardrailVersion: liveGuardrail.version,
              },
            });
          }
        }
      }
    }

    // ---- Step 7: the write ----
    const now = clock.now();

    await tx.prescription.update({
      where: { id: prescription.id },
      data: prescriptionUpdateFor(field, parsed.value),
    });

    await tx.typingSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "ACCEPTED",
        resolvedByUserId: ctx.actor.userId,
        resolvedAt: now,
        appliedCommandLogId: commandLogId,
      },
    });

    // Sibling proposals for the SAME field are now advice about a
    // value that no longer exists — supersede them.
    const superseded = await tx.typingSuggestion.updateMany({
      where: {
        organizationId: orgId,
        prescriptionId: prescription.id,
        field,
        status: "PROPOSED",
        id: { not: suggestion.id },
      },
      data: { status: "SUPERSEDED", resolvedAt: now },
    });

    const fromVersion = target.version;
    const toVersion = target.version + 1;

    return {
      output: {
        suggestionId: suggestion.id,
        prescriptionId: prescription.id,
        field,
        fromVersion,
        toVersion,
        supersededSiblingCount: superseded.count,
      },
      targetOrderId: target.id,
      bumpVersion: { from: fromVersion, to: toVersion },
      audit: {
        action: "ai.typing_suggestion.accepted",
        resourceType: "TypingSuggestion",
        resourceId: suggestion.id,
        metadata: {
          suggestionId: suggestion.id,
          runId: suggestion.runId,
          orderId: target.id,
          prescriptionId: prescription.id,
          source: suggestion.source,
          findingCode: suggestion.findingCode,
          field,
          valueBefore: recordedCurrentValue,
          valueAfter: parsed.value as never,
          confidencePercent: suggestion.confidencePercent,
          fromVersion,
          toVersion,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "ai.typing_suggestion.accepted.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            suggestionId: suggestion.id,
            runId: suggestion.runId,
            organizationId: orgId,
            orderId: target.id,
            prescriptionId: prescription.id,
            source: suggestion.source,
            field,
            acceptedByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
