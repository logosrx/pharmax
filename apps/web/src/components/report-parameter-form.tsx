// ReportParameterForm — renders typed controls from a report's
// declarative `parameterFields` descriptor.
//
// Server component, no client JS: every control is a plain form
// element posting to the run route. Sticky values come from the
// URL searchParams (a failed run redirects back with `?error=`
// and the operator's inputs preserved). Date fields pre-fill from
// their declared `defaultValue` (resolved against `now`) when the
// URL doesn't already carry a value.
//
// Field kinds → controls:
//   date       → <input type="date">
//   enum       → <select>
//   multi-enum → a checkbox group (one <input type="checkbox">
//                per option, all sharing the field name so the
//                route's FormData.getAll collects the selection)
//   text       → <input type="text">
//   number     → <input type="number">
//
// Reports without `parameterFields` fall back to the standard
// date-range pair at the call site (the run page passes
// `dateRangeFields()` in that case), so this component always
// receives a non-empty field list.

import { resolveDateFieldDefault, type ReportParameterField } from "@pharmax/reporting";

interface ReportParameterFormProps {
  readonly reportId: string;
  readonly fields: ReadonlyArray<ReportParameterField>;
  /** Sticky values from the URL searchParams (string or string[]). */
  readonly values: Record<string, string | ReadonlyArray<string> | undefined>;
  /** Clock anchor for resolving date defaults. */
  readonly now: Date;
}

function stickyString(values: ReportParameterFormProps["values"], key: string): string | undefined {
  const v = values[key];
  if (typeof v === "string") return v;
  return undefined;
}

function stickySet(values: ReportParameterFormProps["values"], key: string): ReadonlySet<string> {
  const v = values[key];
  if (Array.isArray(v)) return new Set(v);
  if (typeof v === "string") return new Set([v]);
  return new Set();
}

export function ReportParameterForm({ reportId, fields, values, now }: ReportParameterFormProps) {
  return (
    <form
      action={`/api/ops/reports/${reportId}/run`}
      method="POST"
      className="space-y-4 rounded-md border border-neutral-800 bg-neutral-950 p-4"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <FieldControl key={field.key} field={field} values={values} now={now} />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-neutral-800 pt-4">
        <p className="text-xs text-neutral-500">
          The download streams immediately on success. A <code>report_run</code> row is persisted
          with these parameters + row count + aggregates for SOC-2 audit.
        </p>
        <button
          type="submit"
          className="shrink-0 rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
        >
          Run + download CSV
        </button>
      </div>
    </form>
  );
}

function FieldControl({
  field,
  values,
  now,
}: {
  readonly field: ReportParameterField;
  readonly values: ReportParameterFormProps["values"];
  readonly now: Date;
}) {
  const labelText = (
    <span className="block text-xs font-medium uppercase tracking-wide text-neutral-400">
      {field.label}
      {field.required ? <span className="text-red-400"> *</span> : null}
    </span>
  );

  const help =
    field.help !== undefined ? (
      <span className="mt-1 block text-xs text-neutral-500">{field.help}</span>
    ) : null;

  switch (field.kind) {
    case "date": {
      const sticky = stickyString(values, field.key);
      const value = sticky ?? resolveDateFieldDefault(field.defaultValue, now);
      return (
        <label className="space-y-1">
          {labelText}
          <input
            type="date"
            name={field.key}
            required={field.required}
            defaultValue={value}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
          />
          {help}
        </label>
      );
    }
    case "enum": {
      const sticky = stickyString(values, field.key) ?? field.defaultValue ?? "";
      return (
        <label className="space-y-1">
          {labelText}
          <select
            name={field.key}
            required={field.required}
            defaultValue={sticky}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          >
            {!field.required ? <option value="">— any —</option> : null}
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {help}
        </label>
      );
    }
    case "multi-enum": {
      const selected = stickySet(values, field.key);
      return (
        <fieldset className="space-y-1 sm:col-span-2">
          {labelText}
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 p-2">
            {field.options.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
              >
                <input
                  type="checkbox"
                  name={field.key}
                  value={opt.value}
                  defaultChecked={selected.has(opt.value)}
                  className="accent-blue-600"
                />
                {opt.label}
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      );
    }
    case "text": {
      const sticky = stickyString(values, field.key) ?? "";
      return (
        <label className="space-y-1">
          {labelText}
          <input
            type="text"
            name={field.key}
            required={field.required}
            defaultValue={sticky}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
          {help}
        </label>
      );
    }
    case "number": {
      const sticky = stickyString(values, field.key) ?? "";
      return (
        <label className="space-y-1">
          {labelText}
          <input
            type="number"
            name={field.key}
            required={field.required}
            defaultValue={sticky}
            min={field.min}
            max={field.max}
            className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          />
          {help}
        </label>
      );
    }
    default: {
      const exhaustive: never = field;
      throw new Error(`Unknown field kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
