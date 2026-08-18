// The suggestion-field vocabulary — the ONLY prescription columns a
// typing suggestion (deterministic or model) may target.
//
// Why a closed list instead of "any column the model names":
//
//   1. PHI boundary. Every field here is a STRUCTURED, non-PHI value
//      (numbers, day counts, coded enums, calendar dates, catalog
//      strength/form strings). Free-text sig, notes, indication —
//      the encrypted columns — are deliberately absent, so a
//      suggestion row is safe to store plaintext, audit, and report on.
//   2. Apply safety. AcceptTypingSuggestion maps a field name to a
//      Prisma write. An open vocabulary would make that mapping a
//      reflection exercise over model output; a closed one makes an
//      unknown field a parse failure before a human ever sees it.
//
// Each field carries a Zod schema for its VALUE. The same schema
// validates in three places: filtering model output in the worker,
// re-validating at accept time, and (deterministic path) asserting our
// own fix values — one vocabulary, one validator, three gates.

import { z } from "zod";

// ---------------------------------------------------------------------
// Value primitives
// ---------------------------------------------------------------------

/** ISO calendar date `YYYY-MM-DD` — same shape the draft carries. */
export const calendarDateValue = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO calendar date (YYYY-MM-DD)");

export const CONTROLLED_SCHEDULE_VALUES = ["NON_CONTROLLED", "CII", "CIII", "CIV", "CV"] as const;

export const SIG_STRUCTURE_KIND_VALUES = ["FIXED", "PRN", "RANGE", "TAPER"] as const;

export const DOSE_UNIT_VALUES = [
  "MG",
  "MCG",
  "G",
  "MEQ",
  "ML",
  "UNIT",
  "TABLET",
  "CAPSULE",
  "DROP",
  "PUFF",
  "SPRAY",
  "PATCH",
  "APPLICATION",
] as const;

// ---------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------

/**
 * `nullable: true` marks fields where "clear the value" is itself a
 * valid proposal (e.g. an earliest-fill date on a non-CII draft).
 * Non-nullable fields reject a null `suggestedValue` at parse time.
 */
export interface TypingSuggestionFieldSpec {
  readonly valueSchema: z.ZodType<unknown>;
  readonly nullable: boolean;
}

export const TYPING_SUGGESTION_FIELD_SPECS = {
  quantityAuthorized: {
    valueSchema: z.number().positive().finite(),
    nullable: false,
  },
  daysSupply: {
    valueSchema: z.int().positive().max(365),
    nullable: false,
  },
  refillsAuthorized: {
    valueSchema: z.int().min(0).max(99),
    nullable: false,
  },
  refillsRemaining: {
    valueSchema: z.int().min(0).max(99),
    nullable: false,
  },
  daw: {
    valueSchema: z.int().min(0).max(9),
    nullable: false,
  },
  expiresAt: {
    valueSchema: calendarDateValue,
    nullable: false,
  },
  earliestFillDate: {
    valueSchema: calendarDateValue,
    nullable: true,
  },
  controlledSubstanceSchedule: {
    valueSchema: z.enum(CONTROLLED_SCHEDULE_VALUES),
    nullable: false,
  },
  sigStructureKind: {
    valueSchema: z.enum(SIG_STRUCTURE_KIND_VALUES),
    nullable: true,
  },
  doseAmount: {
    valueSchema: z.number().positive().finite(),
    nullable: true,
  },
  doseUnit: {
    valueSchema: z.enum(DOSE_UNIT_VALUES),
    nullable: true,
  },
  dosesPerDay: {
    valueSchema: z.number().positive().finite(),
    nullable: true,
  },
  drugStrength: {
    valueSchema: z.string().min(1).max(100),
    nullable: true,
  },
  drugForm: {
    valueSchema: z.string().min(1).max(100),
    nullable: true,
  },
} as const satisfies Record<string, TypingSuggestionFieldSpec>;

export type TypingSuggestionField = keyof typeof TYPING_SUGGESTION_FIELD_SPECS;

export const TYPING_SUGGESTION_FIELDS = Object.keys(
  TYPING_SUGGESTION_FIELD_SPECS
) as ReadonlyArray<TypingSuggestionField>;

export function isTypingSuggestionField(value: string): value is TypingSuggestionField {
  return Object.prototype.hasOwnProperty.call(TYPING_SUGGESTION_FIELD_SPECS, value);
}

/**
 * Validate one (field, value) pair against the vocabulary. Returns the
 * parsed value on success. Null is accepted only for nullable fields.
 * Total over its inputs — the caller decides whether a failure is a
 * throw (accept path) or a drop (model-output filtering).
 */
export function parseSuggestionValue(
  field: TypingSuggestionField,
  value: unknown
):
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  const spec: TypingSuggestionFieldSpec = TYPING_SUGGESTION_FIELD_SPECS[field];
  if (value === null) {
    return spec.nullable
      ? { ok: true, value: null }
      : { ok: false, reason: `${field} cannot be cleared` };
  }
  const parsed = spec.valueSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid value" };
}
