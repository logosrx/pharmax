// The model stage of a typing-suggestion run — executed by the worker
// after `ai.typing_suggestion_run.requested.v1`, never inline in the
// request command (a model call inside a row-locked tx would hold the
// order lock for network latency).
//
// Contract (mirrors the outbox-handler contract it runs under):
//
//   - IDEMPOTENT: keyed on the run's status. Only PENDING_MODEL runs
//     do work; a redelivered event against a COMPLETED/FAILED run is a
//     recorded no-op.
//   - LOUD: every terminal path writes the run row. A missing model
//     port is FAILED("MODEL_NOT_CONFIGURED"); unparseable output is
//     FAILED("MODEL_OUTPUT_INVALID"); a thrown provider error is
//     FAILED("MODEL_CALL_FAILED"). There is no path where the run
//     stays PENDING_MODEL silently.
//   - RE-GATED: the phase-1 gate is recomputed from the LIVE policy +
//     guardrail rows. A tenant who flipped the kill switch between
//     request and worker pickup wins — the run completes with zero
//     suggestions and failureCode null, recording the late skip.
//   - BOUNDED: model output passes shape parsing, then the tenant
//     filter (confidence threshold, guardrail ceilings, no-op and
//     duplicate drops), then a PHI tripwire over each surviving
//     rationale — a rationale that echoes identifying text is replaced
//     with a generic sentence rather than persisted.
//
// PHI: the decrypted sig goes to the model provider (BAA boundary,
// zero retention) unless the tripwire fires — see prompt.ts. Nothing
// PHI is written to the run, the suggestions, or any log line here.

import { decryptField } from "@pharmax/crypto";
import type { PrismaClient } from "@pharmax/database";
import { phi } from "@pharmax/platform-core";

import type { GuardrailFacts, PolicyFacts, TypingDraft } from "../evaluate-typing-draft.js";
import { toSuggestionJsonInput } from "../suggestions/json-input.js";
import { buildTypingSuggestionPrompt } from "./prompt.js";
import { filterModelSuggestions, parseModelSuggestions } from "./output.js";
import type { TypingModelPort } from "./port.js";

// Failure codes recorded on the run row. Exported for the UI/tests.
export const MODEL_FAILURE_CODES = {
  MODEL_NOT_CONFIGURED: "MODEL_NOT_CONFIGURED",
  MODEL_CALL_FAILED: "MODEL_CALL_FAILED",
  MODEL_OUTPUT_INVALID: "MODEL_OUTPUT_INVALID",
  RUN_CONTEXT_MISSING: "RUN_CONTEXT_MISSING",
} as const;

export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[keyof typeof MODEL_FAILURE_CODES];

export interface RunModelStageInput {
  /** Tenant-scoped client (the caller establishes tenancy context). */
  readonly client: PrismaClient;
  readonly organizationId: string;
  readonly runId: string;
  /** Null = no provider configured in this environment. */
  readonly modelPort: TypingModelPort | null;
  readonly now: () => Date;
}

export type RunModelStageResult =
  | {
      readonly outcome: "COMPLETED";
      readonly suggestionCount: number;
      readonly droppedCount: number;
    }
  | { readonly outcome: "FAILED"; readonly failureCode: ModelFailureCode }
  | { readonly outcome: "SKIPPED_TERMINAL"; readonly status: string }
  | { readonly outcome: "SKIPPED_GATE_CLOSED" };

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function runTypingSuggestionModelStage(
  input: RunModelStageInput
): Promise<RunModelStageResult> {
  const { client, organizationId, runId, modelPort } = input;

  const run = await client.typingSuggestionRun.findFirst({
    where: { id: runId, organizationId },
    select: { id: true, status: true, orderId: true, prescriptionId: true },
  });
  if (run === null) {
    // A run id we cannot see is either a cross-tenant probe (RLS
    // already refused it) or a genuinely missing row; neither is
    // retryable, and there is no run row to mark FAILED.
    return { outcome: "FAILED", failureCode: MODEL_FAILURE_CODES.RUN_CONTEXT_MISSING };
  }
  if (run.status !== "PENDING_MODEL") {
    return { outcome: "SKIPPED_TERMINAL", status: run.status };
  }

  const failRun = async (failureCode: ModelFailureCode): Promise<RunModelStageResult> => {
    await client.typingSuggestionRun.update({
      where: { id: run.id },
      data: { status: "FAILED", failureCode, completedAt: input.now() },
    });
    return { outcome: "FAILED", failureCode };
  };

  if (modelPort === null) {
    return failRun(MODEL_FAILURE_CODES.MODEL_NOT_CONFIGURED);
  }

  // ---- Rebuild the evaluation context from live rows ----

  const prescription = await client.prescription.findFirst({
    where: { id: run.prescriptionId, organizationId },
    select: {
      id: true,
      drugNdc: true,
      drugName: true,
      drugStrength: true,
      drugForm: true,
      quantityAuthorized: true,
      daysSupply: true,
      refillsAuthorized: true,
      refillsRemaining: true,
      originalDateWritten: true,
      expiresAt: true,
      daw: true,
      controlledSubstanceSchedule: true,
      earliestFillDate: true,
      sigStructureKind: true,
      doseAmount: true,
      doseUnit: true,
      dosesPerDay: true,
      sigEnc: true,
    },
  });
  if (prescription === null) {
    return failRun(MODEL_FAILURE_CODES.RUN_CONTEXT_MISSING);
  }

  const catalogProduct = await client.product.findFirst({
    where: { organizationId, ndc: prescription.drugNdc },
    select: { id: true, controlledSubstanceSchedule: true },
  });

  const guardrailRow =
    catalogProduct === null
      ? null
      : await client.productAiGuardrail.findFirst({
          where: { organizationId, productId: catalogProduct.id },
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

  const policyRow = await client.aiAssistPolicy.findFirst({
    where: { organizationId },
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

  // ---- Late re-gate against the LIVE switches ----
  const draftSchedule = prescription.controlledSubstanceSchedule;
  const productSchedule = catalogProduct?.controlledSubstanceSchedule ?? draftSchedule;
  const controlled = draftSchedule !== "NON_CONTROLLED" || productSchedule !== "NON_CONTROLLED";
  const gateOpen =
    policy !== null &&
    policy.typingAssistEnabled &&
    (guardrail === null || guardrail.aiSuggestionsEnabled) &&
    (!controlled || policy.allowControlledSubstanceSuggestions);
  if (!gateOpen) {
    await client.typingSuggestionRun.update({
      where: { id: run.id },
      data: {
        status: "MODEL_SKIPPED",
        modelSkipReasonCode: "GATE_CLOSED_AT_EXECUTION",
        completedAt: input.now(),
      },
    });
    return { outcome: "SKIPPED_GATE_CLOSED" };
  }

  const draft: TypingDraft = {
    quantityAuthorized: Number(prescription.quantityAuthorized),
    daysSupply: prescription.daysSupply,
    refillsAuthorized: prescription.refillsAuthorized,
    refillsRemaining: prescription.refillsRemaining,
    originalDateWritten: isoDate(prescription.originalDateWritten),
    expiresAt: isoDate(prescription.expiresAt),
    daw: prescription.daw,
    controlledSubstanceSchedule: draftSchedule,
    earliestFillDate:
      prescription.earliestFillDate === null ? null : isoDate(prescription.earliestFillDate),
  };

  const structuredSig = {
    sigStructureKind: prescription.sigStructureKind,
    doseAmount: prescription.doseAmount === null ? null : Number(prescription.doseAmount),
    doseUnit: prescription.doseUnit,
    dosesPerDay: prescription.dosesPerDay === null ? null : Number(prescription.dosesPerDay),
  };

  // Sig decryption: an AAD-verified read of the exact row's column.
  // A decrypt failure is not fatal to the run — the model still
  // reviews structured coherence with the sig withheld.
  let sigText: string | null;
  try {
    sigText = await decryptField({
      envelope: prescription.sigEnc,
      binding: {
        tenantId: organizationId,
        table: "prescription",
        column: "sig",
        recordId: prescription.id,
      },
    });
  } catch {
    sigText = null;
  }

  const prompt = buildTypingSuggestionPrompt({
    draft,
    sigText,
    structuredSig,
    drug: {
      name: prescription.drugName,
      strength: prescription.drugStrength,
      form: prescription.drugForm,
      catalogSchedule: productSchedule,
    },
    // The worker does not re-run the deterministic evaluator: the
    // finding codes from request time are not persisted per-run, and
    // re-deriving them here would race row edits. The model is told
    // codes may exist; an occasional restated finding is dropped by
    // the technician, not a safety hole.
    deterministicFindingCodes: [],
  });

  // ---- The model call ----
  const startedAt = Date.now();
  let response;
  try {
    response = await modelPort.complete(prompt.request);
  } catch {
    return failRun(MODEL_FAILURE_CODES.MODEL_CALL_FAILED);
  }
  const latencyMs = Date.now() - startedAt;

  const parsed = parseModelSuggestions(response.text);
  if (!parsed.ok) {
    await client.typingSuggestionRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        failureCode: MODEL_FAILURE_CODES.MODEL_OUTPUT_INVALID,
        provider: modelPort.provider,
        modelId: response.modelId,
        promptVersion: prompt.promptVersion,
        inputDigestSha256: prompt.inputDigestSha256,
        sigOmittedByPhiTripwire: prompt.sigOmitted,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs,
        completedAt: input.now(),
      },
    });
    return { outcome: "FAILED", failureCode: MODEL_FAILURE_CODES.MODEL_OUTPUT_INVALID };
  }

  const filtered = filterModelSuggestions({
    candidates: parsed.suggestions,
    draft,
    structuredSig,
    drug: { strength: prescription.drugStrength, form: prescription.drugForm },
    guardrail,
    minConfidencePercent: policyRow?.minConfidencePercent ?? 100,
  });

  // Rationale tripwire: a surviving proposal whose rationale echoes
  // identifying text gets a generic sentence instead. The proposal
  // itself is structured and safe; only the prose is replaced.
  const persistable = filtered.accepted.map((s) => ({
    ...s,
    rationale:
      phi.scanForPhi(s.rationale).length > 0
        ? "Model rationale withheld (matched a PHI tripwire rule); the proposed value stands on the structured inputs."
        : s.rationale,
  }));

  const now = input.now();
  await client.$transaction(async (tx) => {
    if (persistable.length > 0) {
      await tx.typingSuggestion.createMany({
        data: persistable.map((s) => ({
          organizationId,
          runId: run.id,
          orderId: run.orderId,
          prescriptionId: run.prescriptionId,
          source: "MODEL" as const,
          field: s.field,
          currentValue: toSuggestionJsonInput(s.currentValue),
          suggestedValue: toSuggestionJsonInput(s.suggestedValue),
          rationale: s.rationale,
          confidencePercent: s.confidencePercent,
        })),
      });
    }
    await tx.typingSuggestionRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        provider: modelPort.provider,
        modelId: response.modelId,
        promptVersion: prompt.promptVersion,
        inputDigestSha256: prompt.inputDigestSha256,
        sigOmittedByPhiTripwire: prompt.sigOmitted,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs,
        completedAt: now,
      },
    });
  });

  return {
    outcome: "COMPLETED",
    suggestionCount: persistable.length,
    droppedCount: filtered.dropped.length,
  };
}
