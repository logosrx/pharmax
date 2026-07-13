// parseReportParameters — coerce raw form values into the typed
// parameter object a report's Zod schema expects.
//
// This is the bridge between the HTML form (everything is a
// string, multi-selects are string arrays) and the report's
// schema (Dates, enums, numbers, string arrays). It does the
// MINIMAL coercion the schema needs; the schema itself remains
// the validation authority — `RunReport` re-parses the output of
// this function and surfaces `REPORT_PARAMETERS_INVALID` on any
// mismatch (e.g. `from > to`).
//
// Coercion rules per field kind:
//   date       → `new Date(value + "T00:00:00.000Z")` (UTC anchor);
//                fields flagged `endOfDay` anchor at 23:59:59.999Z
//                so `lte`-filtered window ends include the whole
//                selected day. Blank required → error; blank
//                optional → omitted.
//   enum       → passthrough string; blank optional → omitted.
//   multi-enum → array of selected strings; empty → omitted (the
//                schema's `.optional()` then means "all").
//   text       → trimmed string; blank optional → omitted.
//   number     → `Number(value)`; non-numeric → error.
//
// Returns the parsed object on success or a typed field-level
// error the route surfaces as a redirect `?error=`.

import type { ReportParameterField } from "./parameter-fields.js";

/** Minimal read surface — works for both `FormData` and a plain
 *  record (JSON body). For multi-enum we need ALL values for a
 *  key, which `FormData.getAll` provides; the record path expects
 *  an array value. */
export interface ParamSource {
  get(key: string): string | null;
  getAll(key: string): ReadonlyArray<string>;
}

export type ParseReportParametersResult =
  | { readonly ok: true; readonly parameters: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

export function paramSourceFromFormData(form: FormData): ParamSource {
  return {
    get: (key) => {
      const v = form.get(key);
      return typeof v === "string" ? v : null;
    },
    getAll: (key) =>
      form
        .getAll(key)
        .filter((v): v is string => typeof v === "string")
        .map((v) => v),
  };
}

export function paramSourceFromRecord(record: Record<string, unknown>): ParamSource {
  return {
    get: (key) => {
      const v = record[key];
      return typeof v === "string" ? v : null;
    },
    getAll: (key) => {
      const v = record[key];
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
      if (typeof v === "string") return [v];
      return [];
    },
  };
}

export function parseReportParameters(
  fields: ReadonlyArray<ReportParameterField>,
  source: ParamSource
): ParseReportParametersResult {
  const out: Record<string, unknown> = {};

  for (const field of fields) {
    switch (field.kind) {
      case "date": {
        const raw = source.get(field.key)?.trim() ?? "";
        if (raw.length === 0) {
          if (field.required) return { ok: false, error: `${field.label} is required.` };
          break;
        }
        // Window-end fields anchor at END of day: reports filter
        // `lte: to`, so a midnight anchor silently excluded the
        // entire selected end date (a same-day report returned
        // near-zero rows).
        const anchor = field.endOfDay === true ? "T23:59:59.999Z" : "T00:00:00.000Z";
        const d = new Date(`${raw}${anchor}`);
        if (Number.isNaN(d.getTime())) {
          return {
            ok: false,
            error: `${field.label} is not a valid date (got "${raw}"). Expected YYYY-MM-DD.`,
          };
        }
        out[field.key] = d;
        break;
      }
      case "enum": {
        const raw = source.get(field.key)?.trim() ?? "";
        if (raw.length === 0) {
          if (field.required) return { ok: false, error: `${field.label} is required.` };
          break;
        }
        out[field.key] = raw;
        break;
      }
      case "multi-enum": {
        const values = source
          .getAll(field.key)
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
        if (values.length === 0) {
          if (field.required)
            return { ok: false, error: `${field.label} requires at least one selection.` };
          break;
        }
        out[field.key] = values;
        break;
      }
      case "text": {
        const raw = source.get(field.key)?.trim() ?? "";
        if (raw.length === 0) {
          if (field.required) return { ok: false, error: `${field.label} is required.` };
          break;
        }
        out[field.key] = raw;
        break;
      }
      case "number": {
        const raw = source.get(field.key)?.trim() ?? "";
        if (raw.length === 0) {
          if (field.required) return { ok: false, error: `${field.label} is required.` };
          break;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          return { ok: false, error: `${field.label} must be a number (got "${raw}").` };
        }
        out[field.key] = n;
        break;
      }
      default: {
        const exhaustive: never = field;
        throw new Error(`Unknown report parameter field kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return { ok: true, parameters: out };
}
