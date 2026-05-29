// Date-placeholder resolver for `parametersTemplate` in
// `report_schedule` rows.
//
// A schedule template carries the report's parameter shape with
// support for a small closed set of placeholder strings in date
// positions:
//
//   { "from": "now-30d", "to": "now" }
//   { "from": "now-7d",  "to": "now" }
//   { "from": "now-24h", "to": "now" }
//
// The resolver walks the template (shallow — only top-level
// values are inspected) and substitutes any recognized
// placeholder string with the matching `Date`. Non-placeholder
// values pass through unchanged (so reports with non-date
// parameters like `clinicId` or `statuses` work as-is).
//
// Why a closed enum vs. a general expression parser:
//   - Operators don't need "every other Tuesday between full
//     moons" — the entire population of useful relative ranges
//     for pharmacy reports is "the last N days / hours". A
//     bounded vocabulary keeps the parse trivial and the audit
//     trail readable ("ran with from=now-30d" tells SOC-2 the
//     exact intent, no need to interpret a custom DSL).
//   - The bus's `RunReport` re-parses the resolved template
//     against the report's own Zod schema, so a malformed
//     resolution surfaces as `REPORT_PARAMETERS_INVALID` —
//     the same path as a malformed on-demand parameter.
//
// PHI invariant: nothing here touches patient data. The
// placeholder vocabulary is closed strings; the resolved values
// are Dates.

export const RELATIVE_DATE_PLACEHOLDERS = [
  "now",
  "now-1h",
  "now-6h",
  "now-12h",
  "now-24h",
  "now-7d",
  "now-14d",
  "now-30d",
  "now-90d",
] as const;

export type RelativeDatePlaceholder = (typeof RELATIVE_DATE_PLACEHOLDERS)[number];

export const RELATIVE_DATE_PLACEHOLDER_SET: ReadonlySet<RelativeDatePlaceholder> = new Set(
  RELATIVE_DATE_PLACEHOLDERS
);

export function isRelativeDatePlaceholder(value: string): value is RelativeDatePlaceholder {
  return RELATIVE_DATE_PLACEHOLDER_SET.has(value as RelativeDatePlaceholder);
}

/**
 * Resolve a placeholder to a concrete Date anchored at `now`.
 * Pure function — same input, same output.
 */
export function resolveRelativeDate(placeholder: RelativeDatePlaceholder, now: Date): Date {
  const ms = now.getTime();
  switch (placeholder) {
    case "now":
      return new Date(ms);
    case "now-1h":
      return new Date(ms - 1 * 60 * 60 * 1000);
    case "now-6h":
      return new Date(ms - 6 * 60 * 60 * 1000);
    case "now-12h":
      return new Date(ms - 12 * 60 * 60 * 1000);
    case "now-24h":
      return new Date(ms - 24 * 60 * 60 * 1000);
    case "now-7d":
      return new Date(ms - 7 * 24 * 60 * 60 * 1000);
    case "now-14d":
      return new Date(ms - 14 * 24 * 60 * 60 * 1000);
    case "now-30d":
      return new Date(ms - 30 * 24 * 60 * 60 * 1000);
    case "now-90d":
      return new Date(ms - 90 * 24 * 60 * 60 * 1000);
    default: {
      const exhaustive: never = placeholder;
      throw new Error(`Unknown relative date placeholder: ${String(exhaustive)}`);
    }
  }
}

/**
 * Walk a parameter template (a plain object) and substitute any
 * top-level string value that matches a recognized placeholder
 * with the corresponding Date. Other values pass through.
 *
 * Returns a fresh object; the input is not mutated.
 */
export function resolveTemplate(input: {
  readonly template: Readonly<Record<string, unknown>>;
  readonly now: Date;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.template)) {
    if (typeof value === "string" && isRelativeDatePlaceholder(value)) {
      out[key] = resolveRelativeDate(value, input.now);
    } else {
      out[key] = value;
    }
  }
  return out;
}
