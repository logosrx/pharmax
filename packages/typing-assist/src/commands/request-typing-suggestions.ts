// RequestTypingSuggestions — start one AI typing-assist evaluation of
// one prescription on an order that is being typed.
//
// What happens synchronously (inside this command's tx):
//
//   1. Order row locked; state must be TYPING_IN_PROGRESS. Suggestions
//      exist to serve the typist mid-review — an order anywhere else
//      in the workflow has no typist to serve, and generating
//      proposals against it would invite an edit outside the typing
//      stage's audit shape.
//   2. The prescription must be attached to THIS order (order-line
//      join, org-scoped) — belt-and-braces with RLS.
//   3. The phase-1 deterministic evaluator runs against the live row +
//      catalog product + tenant guardrail + org policy. Findings with
//      exactly one correct answer become DETERMINISTIC suggestion rows
//      immediately — no model required, no waiting.
//   4. Any still-PROPOSED suggestions from earlier runs on this
//      prescription are marked SUPERSEDED: two runs' proposals side by
//      side would show the technician stale advice about rows that may
//      since have changed.
//   5. A typing_suggestion_run row records the gate verdict and the
//      policy/guardrail revision pins.
//
// What happens asynchronously: if (and only if) the phase-1 gate
// permits model suggestions, the command emits
// `ai.typing_suggestion_run.requested.v1` and the worker performs the
// model stage. The gate result is computed here, inside the tx, from
// the same rows the deterministic evaluator read — the worker
// re-checks it, but the authoritative "was the model allowed?" answer
// is pinned on the run row at request time.
//
// Catalog-miss behavior: a prescription whose NDC has no catalog
// product still gets the internal-consistency validators (product
// facts fall back to the prescription's own schedule snapshot, so no
// catalog-mismatch finding can fire) and has NO guardrail row — which
// means the model gate opens only on the org policy. That is the
// tenant's stated intent: a guardrail is authored per product; a
// product the org never cataloged has no product-level kill switch.
//
// PHI invariant: input is ids only. Audit metadata and the outbox
// payload carry ids, counts, versions, and the gate verdict — no drug
// identity, no sig, no patient reference beyond opaque ids.

import { defineCommand } from "@pharmax/command-bus";
import { OrderStatus, TypingSuggestionRunStatus, TypingSuggestionSource } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  evaluateTypingDraft,
  type ControlledSchedule,
  type GuardrailFacts,
  type PolicyFacts,
  type ProductFacts,
  type TypingDraft,
} from "../evaluate-typing-draft.js";
import { deterministicFixesForFindings } from "../suggestions/deterministic-fixes.js";
import { toSuggestionJsonInput } from "../suggestions/json-input.js";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
// ---------------------------------------------------------------------------

export const TYPING_SUGGESTIONS_ORDER_NOT_IN_TYPING = "TYPING_SUGGESTIONS_ORDER_NOT_IN_TYPING";
export const TYPING_SUGGESTIONS_PRESCRIPTION_NOT_ON_ORDER =
  "TYPING_SUGGESTIONS_PRESCRIPTION_NOT_ON_ORDER";

// Reason codes recorded on MODEL_SKIPPED runs. Exported so the UI can
// explain "why is there no AI column?" without string-matching.
export const MODEL_SKIP_REASONS = {
  POLICY_DISABLED: "POLICY_DISABLED",
  PRODUCT_GUARDRAIL_DISABLED: "PRODUCT_GUARDRAIL_DISABLED",
  CONTROLLED_SUBSTANCE_NOT_OPTED_IN: "CONTROLLED_SUBSTANCE_NOT_OPTED_IN",
} as const;

export type ModelSkipReason = (typeof MODEL_SKIP_REASONS)[keyof typeof MODEL_SKIP_REASONS];

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    prescriptionId: z.uuid(),
  })
  .strict();

export type RequestTypingSuggestionsInput = z.infer<typeof inputSchema>;

export interface RequestTypingSuggestionsOutput {
  readonly runId: string;
  readonly status: "PENDING_MODEL" | "MODEL_SKIPPED";
  readonly modelSkipReasonCode: ModelSkipReason | null;
  readonly deterministicFindingCount: number;
  readonly deterministicSuggestionCount: number;
  readonly supersededSuggestionCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Why did the gate close? Mirrors the gate expression in
 *  `evaluateTypingDraft` — first closed switch wins. */
function skipReasonFor(input: {
  readonly policy: PolicyFacts | null;
  readonly guardrail: GuardrailFacts | null;
  readonly draftSchedule: ControlledSchedule;
  readonly productSchedule: ControlledSchedule;
}): ModelSkipReason {
  if (input.policy === null || !input.policy.typingAssistEnabled) {
    return MODEL_SKIP_REASONS.POLICY_DISABLED;
  }
  if (input.guardrail !== null && !input.guardrail.aiSuggestionsEnabled) {
    return MODEL_SKIP_REASONS.PRODUCT_GUARDRAIL_DISABLED;
  }
  return MODEL_SKIP_REASONS.CONTROLLED_SUBSTANCE_NOT_OPTED_IN;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const RequestTypingSuggestions = defineCommand<
  RequestTypingSuggestionsInput,
  RequestTypingSuggestionsOutput
>({
  name: "RequestTypingSuggestions",
  inputSchema,
  permission: PERMISSIONS.AI_TYPING_SUGGESTIONS_USE,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  // Not a workflow transition and not an order mutation: no policy
  // load, and no version bump — a suggestion request must never CAS-
  // conflict a colleague's real edit.
  redactFields: [],

  async exec({ tx, ctx, input, target, clock }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "REQUEST_TYPING_SUGGESTIONS_NO_TARGET",
        message: "Locked order target was not provided to RequestTypingSuggestions.",
      });
    }

    const orgId = ctx.organizationId;

    // ---- Step 1: state guard ----
    if (target.currentStatus !== OrderStatus.TYPING_IN_PROGRESS) {
      throw new errors.ConflictError({
        code: TYPING_SUGGESTIONS_ORDER_NOT_IN_TYPING,
        message: `Order is in state ${target.currentStatus}; typing suggestions can only be requested while typing is in progress.`,
        metadata: { orderId: target.id, currentStatus: target.currentStatus },
      });
    }

    // ---- Step 2: the prescription must be ON this order ----
    const orderLine = await tx.orderLine.findFirst({
      where: { organizationId: orgId, orderId: target.id, prescriptionId: input.prescriptionId },
      select: { id: true },
    });
    if (orderLine === null) {
      throw new errors.ConflictError({
        code: TYPING_SUGGESTIONS_PRESCRIPTION_NOT_ON_ORDER,
        message: "Prescription is not attached to this order.",
        metadata: { orderId: target.id, prescriptionId: input.prescriptionId },
      });
    }

    // ---- Step 3: load the draft + facts ----
    const prescription = await tx.prescription.findFirst({
      where: { id: input.prescriptionId, organizationId: orgId },
      select: {
        id: true,
        drugNdc: true,
        quantityAuthorized: true,
        daysSupply: true,
        refillsAuthorized: true,
        refillsRemaining: true,
        originalDateWritten: true,
        expiresAt: true,
        daw: true,
        controlledSubstanceSchedule: true,
        earliestFillDate: true,
      },
    });
    if (prescription === null) {
      // The order line exists but its prescription does not — RLS
      // cannot produce this for a same-org row; treat as internal.
      throw new errors.InternalError({
        code: "REQUEST_TYPING_SUGGESTIONS_PRESCRIPTION_VANISHED",
        message: "Prescription row is missing for an existing order line.",
        metadata: { prescriptionId: input.prescriptionId },
      });
    }

    const draft: TypingDraft = {
      quantityAuthorized: Number(prescription.quantityAuthorized),
      daysSupply: prescription.daysSupply,
      refillsAuthorized: prescription.refillsAuthorized,
      refillsRemaining: prescription.refillsRemaining,
      originalDateWritten: isoDate(prescription.originalDateWritten),
      expiresAt: isoDate(prescription.expiresAt),
      daw: prescription.daw,
      controlledSubstanceSchedule: prescription.controlledSubstanceSchedule,
      earliestFillDate:
        prescription.earliestFillDate === null ? null : isoDate(prescription.earliestFillDate),
    };

    const catalogProduct = await tx.product.findFirst({
      where: { organizationId: orgId, ndc: prescription.drugNdc },
      select: { id: true, controlledSubstanceSchedule: true },
    });

    // Catalog miss: fall back to the prescription's own schedule so
    // internal-consistency validation still runs and no spurious
    // catalog-mismatch finding can fire.
    const product: ProductFacts = {
      controlledSubstanceSchedule:
        catalogProduct?.controlledSubstanceSchedule ?? prescription.controlledSubstanceSchedule,
    };

    const guardrailRow =
      catalogProduct === null
        ? null
        : await tx.productAiGuardrail.findFirst({
            where: { organizationId: orgId, productId: catalogProduct.id },
            select: {
              aiSuggestionsEnabled: true,
              maxQuantityPerFill: true,
              maxDaysSupplyPerFill: true,
              maxRefillsAuthorized: true,
              version: true,
            },
          });
    const guardrail: GuardrailFacts | null =
      guardrailRow === null
        ? null
        : {
            aiSuggestionsEnabled: guardrailRow.aiSuggestionsEnabled,
            maxQuantityPerFill:
              guardrailRow.maxQuantityPerFill === null
                ? null
                : Number(guardrailRow.maxQuantityPerFill),
            maxDaysSupplyPerFill: guardrailRow.maxDaysSupplyPerFill,
            maxRefillsAuthorized: guardrailRow.maxRefillsAuthorized,
            version: guardrailRow.version,
          };

    const policyRow = await tx.aiAssistPolicy.findFirst({
      where: { organizationId: orgId },
      select: {
        typingAssistEnabled: true,
        minConfidencePercent: true,
        allowControlledSubstanceSuggestions: true,
        version: true,
      },
    });
    const policy: PolicyFacts | null =
      policyRow === null
        ? null
        : {
            typingAssistEnabled: policyRow.typingAssistEnabled,
            allowControlledSubstanceSuggestions: policyRow.allowControlledSubstanceSuggestions,
            version: policyRow.version,
          };

    const now = clock.now();

    // ---- Step 4: deterministic evaluation + fixes ----
    const evaluation = evaluateTypingDraft({
      draft,
      product,
      guardrail,
      policy,
      today: isoDate(now),
    });
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail,
      findings: evaluation.findings,
    });

    // ---- Step 5: supersede prior open proposals for this Rx ----
    const superseded = await tx.typingSuggestion.updateMany({
      where: {
        organizationId: orgId,
        orderId: target.id,
        prescriptionId: prescription.id,
        status: "PROPOSED",
      },
      data: { status: "SUPERSEDED", resolvedAt: now },
    });

    // ---- Step 6: persist the run + deterministic suggestions ----
    const status = evaluation.modelSuggestionsPermitted
      ? TypingSuggestionRunStatus.PENDING_MODEL
      : TypingSuggestionRunStatus.MODEL_SKIPPED;
    const modelSkipReasonCode = evaluation.modelSuggestionsPermitted
      ? null
      : skipReasonFor({
          policy,
          guardrail,
          draftSchedule: draft.controlledSubstanceSchedule,
          productSchedule: product.controlledSubstanceSchedule,
        });

    const run = await tx.typingSuggestionRun.create({
      data: {
        organizationId: orgId,
        orderId: target.id,
        prescriptionId: prescription.id,
        requestedByUserId: ctx.actor.userId,
        status,
        modelSuggestionsPermitted: evaluation.modelSuggestionsPermitted,
        modelSkipReasonCode,
        policyVersion: evaluation.policyVersion,
        guardrailVersion: evaluation.guardrailVersion,
        minConfidencePercent: policyRow?.minConfidencePercent ?? null,
        deterministicFindingCount: evaluation.findings.length,
        ...(status === TypingSuggestionRunStatus.MODEL_SKIPPED ? { completedAt: now } : {}),
      },
      select: { id: true },
    });

    if (fixes.length > 0) {
      await tx.typingSuggestion.createMany({
        data: fixes.map((fix) => ({
          organizationId: orgId,
          runId: run.id,
          orderId: target.id,
          prescriptionId: prescription.id,
          source: TypingSuggestionSource.DETERMINISTIC,
          findingCode: fix.findingCode,
          field: fix.field,
          currentValue: toSuggestionJsonInput(fix.currentValue),
          suggestedValue: toSuggestionJsonInput(fix.suggestedValue),
          rationale: fix.rationale,
        })),
      });
    }

    return {
      output: {
        runId: run.id,
        status: evaluation.modelSuggestionsPermitted ? "PENDING_MODEL" : "MODEL_SKIPPED",
        modelSkipReasonCode,
        deterministicFindingCount: evaluation.findings.length,
        deterministicSuggestionCount: fixes.length,
        supersededSuggestionCount: superseded.count,
      },
      targetOrderId: target.id,
      audit: {
        action: "ai.typing_suggestion_run.requested",
        resourceType: "TypingSuggestionRun",
        resourceId: run.id,
        metadata: {
          runId: run.id,
          orderId: target.id,
          prescriptionId: prescription.id,
          modelSuggestionsPermitted: evaluation.modelSuggestionsPermitted,
          modelSkipReasonCode,
          policyVersion: evaluation.policyVersion,
          guardrailVersion: evaluation.guardrailVersion,
          deterministicFindingCount: evaluation.findings.length,
          deterministicSuggestionCount: fixes.length,
          supersededSuggestionCount: superseded.count,
        },
      },
      emits: evaluation.modelSuggestionsPermitted
        ? [
            {
              eventType: "ai.typing_suggestion_run.requested.v1",
              aggregateType: "TypingSuggestionRun",
              aggregateId: run.id,
              payload: {
                runId: run.id,
                organizationId: orgId,
                orderId: target.id,
                prescriptionId: prescription.id,
                requestedByUserId: ctx.actor.userId,
                policyVersion: evaluation.policyVersion,
                guardrailVersion: evaluation.guardrailVersion,
                occurredAt: now.toISOString(),
              },
            },
          ]
        : [],
    };
  },
});
