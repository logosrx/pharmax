// Declarative parameter-field descriptors for report definitions.
//
// WHY a declarative descriptor instead of reflecting over the Zod
// schema:
//   - Zod internals (`._def`, effect wrappers from `.refine()`,
//     `.strict()`) are version-unstable and awkward to walk. A
//     report's schema is often `z.object({...}).strict().refine()`
//     — the refine wrapper hides the shape from naive reflection.
//   - The UI needs labels, help text, option display names, and
//     sensible defaults that DON'T belong in the validation
//     schema. Keeping them here lets the schema stay purely about
//     validation while the form stays purely about presentation.
//   - The Zod schema remains the SINGLE source of truth for
//     validation: `parseReportParameters` coerces form strings to
//     the typed shape, then the bus's `RunReport` re-parses that
//     shape against the report's own schema. A descriptor that
//     drifts from its schema fails loudly at run time (the report
//     rejects the params) rather than silently mis-validating.
//
// A report MAY omit `parameterFields`; the run UI falls back to
// the legacy hardcoded `from`/`to` date pair (every shipped
// report takes a date range, so the fallback is always safe).

/** Relative-date defaults the form can pre-fill a `date` field
 *  with. Mirrors a subset of the schedule placeholder vocabulary
 *  so the two surfaces feel consistent. */
export type ReportDateFieldDefault = "today" | "now-7d" | "now-30d" | "now-90d";

interface BaseField {
  /** Form field name + the key on the parsed parameters object. */
  readonly key: string;
  /** Operator-facing label. */
  readonly label: string;
  /** Optional one-line help text rendered under the control. */
  readonly help?: string;
  /** Whether the field must be provided. Optional fields that are
   *  left blank are omitted from the parsed object entirely (so
   *  the report's schema default / `.optional()` applies). */
  readonly required: boolean;
}

export interface ReportDateField extends BaseField {
  readonly kind: "date";
  /** Pre-fill value for the `<input type=date>`. */
  readonly defaultValue?: ReportDateFieldDefault;
}

export interface ReportEnumOption {
  readonly value: string;
  readonly label: string;
}

export interface ReportEnumField extends BaseField {
  readonly kind: "enum";
  readonly options: ReadonlyArray<ReportEnumOption>;
  readonly defaultValue?: string;
}

export interface ReportMultiEnumField extends BaseField {
  readonly kind: "multi-enum";
  readonly options: ReadonlyArray<ReportEnumOption>;
}

export interface ReportTextField extends BaseField {
  readonly kind: "text";
  readonly placeholder?: string;
  readonly maxLength?: number;
}

export interface ReportNumberField extends BaseField {
  readonly kind: "number";
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue?: number;
}

export type ReportParameterField =
  | ReportDateField
  | ReportEnumField
  | ReportMultiEnumField
  | ReportTextField
  | ReportNumberField;

/**
 * The standard `from` + `to` date-range pair every shipped report
 * uses. Reports compose this with their own fields:
 *
 *   parameterFields: [...dateRangeFields(), statusesMultiEnum]
 */
export function dateRangeFields(
  options: {
    readonly fromDefault?: ReportDateFieldDefault;
    readonly toDefault?: ReportDateFieldDefault;
  } = {}
): ReadonlyArray<ReportParameterField> {
  return [
    {
      kind: "date",
      key: "from",
      label: "From",
      required: true,
      help: "Start of the report window (inclusive).",
      defaultValue: options.fromDefault ?? "now-30d",
    },
    {
      kind: "date",
      key: "to",
      label: "To",
      required: true,
      help: "End of the report window (inclusive).",
      defaultValue: options.toDefault ?? "today",
    },
  ];
}

/**
 * Resolve a `ReportDateFieldDefault` to the `YYYY-MM-DD` string an
 * `<input type=date>` expects, anchored at the given `now`.
 */
export function resolveDateFieldDefault(
  value: ReportDateFieldDefault | undefined,
  now: Date
): string {
  if (value === undefined) return "";
  const ms = now.getTime();
  const day = 24 * 60 * 60 * 1000;
  switch (value) {
    case "today":
      return toDateInputValue(now);
    case "now-7d":
      return toDateInputValue(new Date(ms - 7 * day));
    case "now-30d":
      return toDateInputValue(new Date(ms - 30 * day));
    case "now-90d":
      return toDateInputValue(new Date(ms - 90 * day));
    default: {
      const exhaustive: never = value;
      throw new Error(`Unknown date field default: ${String(exhaustive)}`);
    }
  }
}

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}
