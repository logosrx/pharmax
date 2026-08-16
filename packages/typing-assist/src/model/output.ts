// Model-output parsing + filtering for the typing-suggestion stage.
//
// Two layers, both pure:
//
//   1. `parseModelSuggestions` — is the response the shape we asked
//      for? Anything else (prose, fences, unknown fields, out-of-range
//      confidence) is a parse FAILURE for that item or the whole
//      response — a model returning something we did not ask for is an
//      error condition, not material to forward to a technician.
//   2. `filterModelSuggestions` — of the well-formed proposals, which
//      may a technician actually SEE? This is where the tenant's
//      guardrail and policy bite: below-threshold confidence, values
//      that breach a ceiling, no-op proposals, and duplicate fields
//      are dropped. Every drop is returned with a reason so the run
//      can be debugged without re-calling the model.
//
// A proposal that survives both layers is still only a PROPOSAL — the
// accept command re-validates everything against the live row before
// any write.

import { z } from "zod";

import type { GuardrailFacts, TypingDraft } from "../evaluate-typing-draft.js";
import {
  TYPING_SUGGESTION_FIELDS,
  parseSuggestionValue,
  type TypingSuggestionField,
} from "../suggestions/fields.js";

// ---------------------------------------------------------------------
// Layer 1: shape
// ---------------------------------------------------------------------

const rawSuggestionSchema = z
  .object({
    field: z.enum(TYPING_SUGGESTION_FIELDS as [TypingSuggestionField, ...TypingSuggestionField[]]),
    proposedValue: z.union([z.string().max(200), z.number(), z.null()]),
    rationale: z.string().min(1).max(400),
    confidencePercent: z.int().min(0).max(100),
  })
  .strict();

const modelOutputSchema = z
  .object({
    suggestions: z.array(rawSuggestionSchema).max(10),
  })
  .strict();

export type RawModelSuggestion = z.infer<typeof rawSuggestionSchema>;

/**
 * Strip markdown fences / surrounding prose and extract the first
 * balanced JSON object. Models occasionally wrap JSON despite
 * instructions; unwrapping is mechanical and loses nothing, so it is
 * handled here rather than failing the run on cosmetics.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type ParseModelSuggestionsResult =
  | { readonly ok: true; readonly suggestions: ReadonlyArray<RawModelSuggestion> }
  | { readonly ok: false; readonly reason: string };

export function parseModelSuggestions(text: string): ParseModelSuggestionsResult {
  const jsonText = extractJsonObject(text);
  if (jsonText === null) {
    return { ok: false, reason: "response contains no JSON object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "response JSON does not parse" };
  }
  const result = modelOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: `response JSON does not match the requested shape: ${
        result.error.issues[0]?.message ?? "unknown issue"
      }`,
    };
  }
  return { ok: true, suggestions: result.data.suggestions };
}

// ---------------------------------------------------------------------
// Layer 2: tenant gates
// ---------------------------------------------------------------------

export interface AcceptedModelSuggestion {
  readonly field: TypingSuggestionField;
  /** Parsed + vocabulary-validated value (null = clear the field). */
  readonly suggestedValue: unknown;
  /** Draft value the proposal replaces. */
  readonly currentValue: unknown;
  readonly rationale: string;
  readonly confidencePercent: number;
}

export interface DroppedModelSuggestion {
  readonly field: string;
  readonly reason: string;
}

export interface FilterModelSuggestionsInput {
  readonly candidates: ReadonlyArray<RawModelSuggestion>;
  readonly draft: TypingDraft;
  readonly structuredSig: {
    readonly sigStructureKind: string | null;
    readonly doseAmount: number | null;
    readonly doseUnit: string | null;
    readonly dosesPerDay: number | null;
  };
  readonly drug: {
    readonly strength: string | null;
    readonly form: string | null;
  };
  readonly guardrail: GuardrailFacts | null;
  /** From the run's policy snapshot; proposals below it are dropped. */
  readonly minConfidencePercent: number;
}

export interface FilterModelSuggestionsResult {
  readonly accepted: ReadonlyArray<AcceptedModelSuggestion>;
  readonly dropped: ReadonlyArray<DroppedModelSuggestion>;
}

function currentValueForField(
  field: TypingSuggestionField,
  input: FilterModelSuggestionsInput
): unknown {
  const { draft, structuredSig, drug } = input;
  switch (field) {
    case "quantityAuthorized":
      return draft.quantityAuthorized;
    case "daysSupply":
      return draft.daysSupply;
    case "refillsAuthorized":
      return draft.refillsAuthorized;
    case "refillsRemaining":
      return draft.refillsRemaining;
    case "daw":
      return draft.daw;
    case "expiresAt":
      return draft.expiresAt;
    case "earliestFillDate":
      return draft.earliestFillDate;
    case "controlledSubstanceSchedule":
      return draft.controlledSubstanceSchedule;
    case "sigStructureKind":
      return structuredSig.sigStructureKind;
    case "doseAmount":
      return structuredSig.doseAmount;
    case "doseUnit":
      return structuredSig.doseUnit;
    case "dosesPerDay":
      return structuredSig.dosesPerDay;
    case "drugStrength":
      return drug.strength;
    case "drugForm":
      return drug.form;
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

/** Would this proposal itself breach a guardrail ceiling? A model must
 *  never be able to talk a technician INTO a guardrail violation. */
function guardrailViolation(
  field: TypingSuggestionField,
  value: unknown,
  guardrail: GuardrailFacts | null
): string | null {
  if (guardrail === null || typeof value !== "number") return null;
  if (
    field === "quantityAuthorized" &&
    guardrail.maxQuantityPerFill !== null &&
    value > guardrail.maxQuantityPerFill
  ) {
    return `proposed quantity ${value} exceeds guardrail ceiling ${guardrail.maxQuantityPerFill}`;
  }
  if (
    field === "daysSupply" &&
    guardrail.maxDaysSupplyPerFill !== null &&
    value > guardrail.maxDaysSupplyPerFill
  ) {
    return `proposed days supply ${value} exceeds guardrail ceiling ${guardrail.maxDaysSupplyPerFill}`;
  }
  if (
    (field === "refillsAuthorized" || field === "refillsRemaining") &&
    guardrail.maxRefillsAuthorized !== null &&
    value > guardrail.maxRefillsAuthorized
  ) {
    return `proposed refills ${value} exceeds guardrail ceiling ${guardrail.maxRefillsAuthorized}`;
  }
  return null;
}

export function filterModelSuggestions(
  input: FilterModelSuggestionsInput
): FilterModelSuggestionsResult {
  const accepted: AcceptedModelSuggestion[] = [];
  const dropped: DroppedModelSuggestion[] = [];
  const seenFields = new Set<TypingSuggestionField>();

  for (const candidate of input.candidates) {
    if (candidate.confidencePercent < input.minConfidencePercent) {
      dropped.push({
        field: candidate.field,
        reason: `confidence ${candidate.confidencePercent} below org threshold ${input.minConfidencePercent}`,
      });
      continue;
    }

    if (seenFields.has(candidate.field)) {
      dropped.push({ field: candidate.field, reason: "duplicate proposal for the same field" });
      continue;
    }

    const parsed = parseSuggestionValue(candidate.field, candidate.proposedValue);
    if (!parsed.ok) {
      dropped.push({ field: candidate.field, reason: `invalid value: ${parsed.reason}` });
      continue;
    }

    const currentValue = currentValueForField(candidate.field, input);
    if (parsed.value === currentValue) {
      dropped.push({ field: candidate.field, reason: "proposal equals the current value" });
      continue;
    }

    const breach = guardrailViolation(candidate.field, parsed.value, input.guardrail);
    if (breach !== null) {
      dropped.push({ field: candidate.field, reason: breach });
      continue;
    }

    seenFields.add(candidate.field);
    accepted.push({
      field: candidate.field,
      suggestedValue: parsed.value,
      currentValue,
      rationale: candidate.rationale,
      confidencePercent: candidate.confidencePercent,
    });
  }

  return { accepted, dropped };
}
