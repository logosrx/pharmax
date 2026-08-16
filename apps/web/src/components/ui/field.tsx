// Form primitives — Field, Label, controls, and shared control
// classes.
//
// Exposes `inputClass` / `selectClass` / `textareaClass` so server-
// action forms (plain <input>/<select> posting to API routes) get the
// exact same styling as composed <Field> usage. Controls are themed
// (bg-surface-2, focus ring on the brand) and sized to align with the
// `md` Button height.

import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cx } from "./cx.js";

const CONTROL_BASE =
  "block w-full rounded-md border border-line-strong bg-surface-2 px-3 text-sm text-fg " +
  "placeholder:text-subtle shadow-xs transition-colors " +
  "focus:border-brand focus:outline-none focus:ring-2 focus:ring-ring/40 " +
  // Server-side validation errors mark controls with aria-invalid;
  // the red treatment comes for free, no error-prop threading.
  "aria-invalid:border-red-500/60 aria-invalid:focus:border-red-500 " +
  "aria-invalid:focus:ring-red-500/30 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const inputClass = (className?: string): string => cx(CONTROL_BASE, "h-9", className);
export const selectClass = (className?: string): string =>
  cx(CONTROL_BASE, "h-9 appearance-none bg-[length:0]", className);
export const textareaClass = (className?: string): string =>
  cx(CONTROL_BASE, "min-h-20 py-2 leading-relaxed", className);

type LabelableProps = {
  readonly id?: string;
  readonly required?: boolean;
  readonly "aria-required"?: boolean | "true" | "false";
  readonly "aria-describedby"?: string;
};

/**
 * True when `child` is a single form control this Field can wire the
 * label to (our primitives or the bare intrinsic elements). Composite
 * children — checkbox/radio groups with their own inner labels — are
 * exposed as a labelled group instead.
 */
function labelableControl(child: ReactNode): ReactElement<LabelableProps> | null {
  if (!isValidElement<LabelableProps>(child)) return null;
  const t = child.type;
  const ok =
    t === Input ||
    t === Select ||
    t === Textarea ||
    t === "input" ||
    t === "select" ||
    t === "textarea";
  return ok ? child : null;
}

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
  // Stable across SSR + hydration, usable from server and client
  // components alike (useId is part of React's server subset).
  const autoId = useId();
  const labelId = `${autoId}-label`;
  const helpId = `${autoId}-help`;
  const hasLabel = label !== undefined && label !== null;
  const hasHelp = help !== undefined && help !== null;

  // Associate the label + help text with the control without asking
  // call sites to thread ids: a single Input/Select/Textarea child is
  // cloned with an id (unless one exists), aria-describedby → help,
  // and aria-required when the Field is marked required.
  const control = labelableControl(children);
  let content: ReactNode = children;
  let controlId = htmlFor;
  if (control !== null) {
    controlId = htmlFor ?? control.props.id ?? autoId;
    content = cloneElement(control, {
      id: control.props.id ?? controlId,
      ...(hasHelp && control.props["aria-describedby"] === undefined
        ? { "aria-describedby": helpId }
        : {}),
      ...(required === true &&
      control.props.required === undefined &&
      control.props["aria-required"] === undefined
        ? { "aria-required": true }
        : {}),
    });
  }
  // Composite children (checkbox/radio groups) can't take a <label>:
  // expose the caption through role="group" instead.
  const asGroup = hasLabel && control === null && htmlFor === undefined;

  const labelClass = "block text-xs font-medium uppercase tracking-wide text-muted";
  return (
    <div
      className={cx("space-y-1.5", className)}
      {...(asGroup ? { role: "group", "aria-labelledby": labelId } : {})}
    >
      {hasLabel ? (
        asGroup ? (
          <span id={labelId} className={labelClass}>
            {label}
            {required ? (
              <span aria-hidden="true" className="text-tone-danger-accent">
                {" "}
                *
              </span>
            ) : null}
          </span>
        ) : (
          <label id={labelId} htmlFor={controlId} className={labelClass}>
            {label}
            {required ? (
              <span aria-hidden="true" className="text-tone-danger-accent">
                {" "}
                *
              </span>
            ) : null}
          </label>
        )
      ) : null}
      {content}
      {hasHelp ? (
        <p id={helpId} className="text-xs text-subtle">
          {help}
        </p>
      ) : null}
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
