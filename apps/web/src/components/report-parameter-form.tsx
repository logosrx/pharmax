// ReportParameterForm — renders typed controls from a report's
// declarative `parameterFields` descriptor.
//
// Server component, no client JS: every control is a plain form
// element posting to the run route (which streams the CSV download —
// so this stays a native form, not a client ActionForm). Sticky
// values come from the URL searchParams; date fields pre-fill from
// their declared default resolved against `now`.

import { resolveDateFieldDefault, type ReportParameterField } from "@pharmax/reporting";

import { Field, inputClass, selectClass } from "./ui/field.js";
import { buttonClass } from "./ui/button.js";
import { Icon } from "./ui/icon.js";

interface ReportParameterFormProps {
  readonly reportId: string;
  readonly fields: ReadonlyArray<ReportParameterField>;
  readonly values: Record<string, string | ReadonlyArray<string> | undefined>;
  readonly now: Date;
}

function stickyString(values: ReportParameterFormProps["values"], key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
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
      className="space-y-5 rounded-lg border border-line bg-surface p-5"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <FieldControl key={field.key} field={field} values={values} now={now} />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="max-w-md text-xs text-subtle">
          The download streams immediately on success. A <code>report_run</code> row is persisted
          with these parameters, row count, and aggregates for SOC-2 audit.
        </p>
        <button type="submit" className={buttonClass({ variant: "primary" })}>
          <Icon name="reports" size={16} />
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
  const help = field.help;

  switch (field.kind) {
    case "date": {
      const value =
        stickyString(values, field.key) ?? resolveDateFieldDefault(field.defaultValue, now);
      return (
        <Field label={field.label} required={field.required} help={help} htmlFor={field.key}>
          <input
            id={field.key}
            type="date"
            name={field.key}
            required={field.required}
            defaultValue={value}
            className={inputClass("font-mono")}
          />
        </Field>
      );
    }
    case "enum": {
      const sticky = stickyString(values, field.key) ?? field.defaultValue ?? "";
      return (
        <Field label={field.label} required={field.required} help={help} htmlFor={field.key}>
          <select
            id={field.key}
            name={field.key}
            required={field.required}
            defaultValue={sticky}
            className={selectClass()}
          >
            {!field.required ? <option value="">— any —</option> : null}
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
      );
    }
    case "multi-enum": {
      const selected = stickySet(values, field.key);
      return (
        <div className="sm:col-span-2">
          <Field label={field.label} required={field.required} help={help}>
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-md border border-line bg-surface-2 p-2">
              {field.options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-fg transition-colors hover:border-brand/50"
                >
                  <input
                    type="checkbox"
                    name={field.key}
                    value={opt.value}
                    defaultChecked={selected.has(opt.value)}
                    className="accent-brand"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </Field>
        </div>
      );
    }
    case "text": {
      const sticky = stickyString(values, field.key) ?? "";
      return (
        <Field label={field.label} required={field.required} help={help} htmlFor={field.key}>
          <input
            id={field.key}
            type="text"
            name={field.key}
            required={field.required}
            defaultValue={sticky}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            className={inputClass()}
          />
        </Field>
      );
    }
    case "number": {
      const sticky =
        stickyString(values, field.key) ??
        (field.defaultValue !== undefined ? String(field.defaultValue) : "");
      return (
        <Field label={field.label} required={field.required} help={help} htmlFor={field.key}>
          <input
            id={field.key}
            type="number"
            name={field.key}
            required={field.required}
            defaultValue={sticky}
            min={field.min}
            max={field.max}
            className={inputClass()}
          />
        </Field>
      );
    }
    default: {
      const exhaustive: never = field;
      throw new Error(`Unknown field kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
