// EmptyState / ErrorState — the canonical vacant and failed surfaces.
//
// EmptyState is the ONE way a list, table, queue, or panel says
// "nothing here": muted icon in a soft tile, a title that states the
// situation, one line of context, an optional primary action, and an
// optional low-emphasis hint. ErrorState is its failed-load sibling —
// what happened, a retry affordance (for server components a link
// back to the same route re-runs the load), and a mono detail slot
// carrying the error code an operator can quote to support.
//
// The `action` prop accepts either a structured `{ label, href }`
// descriptor — the common case, rendered as a Button-styled link so
// server components never re-assemble Link + buttonClass themselves —
// or any ReactNode for bespoke affordances (forms, client buttons).

import Link from "next/link";
import { isValidElement, type ReactNode } from "react";

import { buttonClass, type ButtonVariant } from "./button.js";
import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";

export interface EmptyStateAction {
  readonly label: string;
  readonly href: string;
  readonly icon?: IconName;
  readonly variant?: ButtonVariant;
}

/**
 * Narrows `action` to the structured link form. A React element is
 * also an object, so `isValidElement` must be ruled out before the
 * shape check means anything.
 */
export function isEmptyStateAction(action: unknown): action is EmptyStateAction {
  if (typeof action !== "object" || action === null || isValidElement(action)) return false;
  const candidate = action as { readonly label?: unknown; readonly href?: unknown };
  return typeof candidate.label === "string" && typeof candidate.href === "string";
}

function ActionSlot({ action }: { readonly action?: EmptyStateAction | ReactNode }) {
  if (action === null || action === undefined) return null;
  if (!isEmptyStateAction(action)) return <div className="mt-1">{action}</div>;
  return (
    <div className="mt-1">
      <Link
        href={action.href}
        className={buttonClass({ variant: action.variant ?? "secondary", size: "sm" })}
      >
        {action.icon !== undefined ? <Icon name={action.icon} size={14} /> : null}
        {action.label}
      </Link>
    </div>
  );
}

export interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Primary affordance: a `{ label, href }` link or any ReactNode. */
  readonly action?: EmptyStateAction | ReactNode;
  /** Secondary low-emphasis hint under the action. */
  readonly hint?: ReactNode;
  readonly className?: string;
}

export function EmptyState({
  icon = "check",
  title,
  description,
  action,
  hint,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line " +
          "bg-surface/50 px-6 py-12 text-center",
        className
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-2 text-muted">
        <Icon name={icon} size={20} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description ? <p className="max-w-sm text-xs text-muted">{description}</p> : null}
      </div>
      <ActionSlot action={action} />
      {hint ? <p className="max-w-sm text-2xs text-subtle">{hint}</p> : null}
    </div>
  );
}

export interface ErrorStateProps {
  readonly icon?: IconName;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Mono error code an operator can quote to support. */
  readonly detail?: string;
  /** Link that re-runs the load — same route for server components. */
  readonly retryHref?: string;
  readonly retryLabel?: string;
  /** Extra affordance beside retry (e.g. a client reset button). */
  readonly action?: EmptyStateAction | ReactNode;
  readonly className?: string;
}

export function ErrorState({
  icon = "alert",
  title = "This data failed to load",
  description,
  detail,
  retryHref,
  retryLabel = "Try again",
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-red-500/25 " +
          "bg-red-500/5 px-6 py-12 text-center animate-fade-in",
        className
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-tone-danger-accent">
        <Icon name={icon} size={20} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description ? <p className="max-w-sm text-xs text-muted">{description}</p> : null}
      </div>
      {retryHref !== undefined ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <Link href={retryHref} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <Icon name="history" size={14} />
            {retryLabel}
          </Link>
        </div>
      ) : null}
      <ActionSlot action={action} />
      {detail !== undefined ? (
        <p className="text-2xs text-subtle">
          Error code{" "}
          <code className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-muted">
            {detail}
          </code>{" "}
          — quote this to support.
        </p>
      ) : null}
    </div>
  );
}
