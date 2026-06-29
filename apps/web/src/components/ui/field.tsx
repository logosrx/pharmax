// Form primitives — Field, Label, controls, and shared control
// classes.
//
// Exposes `inputClass` / `selectClass` / `textareaClass` so server-
// action forms (plain <input>/<select> posting to API routes) get the
// exact same styling as composed <Field> usage. Controls are themed
// (bg-surface-2, focus ring on the brand) and sized to align with the
// `md` Button height.

import type {
  ReactNode,
  SelectHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cx } from "./cx.js";

const CONTROL_BASE =
  "block w-full rounded-md border border-line-strong bg-surface-2 px-3 text-sm text-fg " +
  "placeholder:text-subtle shadow-xs transition-colors " +
  "focus:border-brand focus:outline-none focus:ring-2 focus:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const inputClass = (className?: string): string => cx(CONTROL_BASE, "h-9", className);
export const selectClass = (className?: string): string =>
  cx(CONTROL_BASE, "h-9 appearance-none bg-[length:0]", className);
export const textareaClass = (className?: string): string =>
  cx(CONTROL_BASE, "min-h-20 py-2 leading-relaxed", className);

export function Field({
  label,
  required,
  help,
  htmlFor,
  children,
  className,
}: {
  readonly label?: ReactNode;
  readonly required?: boolean;
  readonly help?: ReactNode;
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx("space-y-1.5", className)}>
      {label ? (
        <label
          htmlFor={htmlFor}
          className="block text-xs font-medium uppercase tracking-wide text-muted"
        >
          {label}
          {required ? <span className="text-red-400"> *</span> : null}
        </label>
      ) : null}
      {children}
      {help ? <p className="text-xs text-subtle">{help}</p> : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={inputClass(className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={selectClass(className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={textareaClass(className)} {...rest} />;
}
