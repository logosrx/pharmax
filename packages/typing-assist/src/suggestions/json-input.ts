// Encoding a suggestion's before/after value for the `Json?` columns
// on `typing_suggestion`.
//
// The distinction Prisma forces here is load-bearing for this table:
//
//   - `Prisma.JsonNull` writes the JSON value `null` — "at proposal
//     time this field WAS null", or "the proposal is to clear this
//     field". Both are real, meaningful values.
//   - `Prisma.DbNull` writes SQL NULL — "no value was recorded".
//
// Every proposal we generate knows both its before-value and its
// after-value, and for nullable fields (`earliestFillDate`,
// `doseAmount`, `drugForm`, …) that value is legitimately null. So a
// null here always means the JSON null, never an absent record —
// which is what keeps AcceptTypingSuggestion's stale-value check
// honest: it compares the live field against the recorded
// before-value, and "was null, still null" must compare equal rather
// than read as "nothing to compare".

import { Prisma } from "@pharmax/database";

/**
 * Suggestion values are constrained to JSON scalars by the field
 * vocabulary (`parseSuggestionValue`), so the cast below narrows an
 * already-validated value rather than asserting over an open type.
 */
export function toSuggestionJsonInput(
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
