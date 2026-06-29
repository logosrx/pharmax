// Page layout primitives — PageHeader, Section, Toolbar.
//
// Every /ops page opens with a <PageHeader> (eyebrow + title +
// description + actions) and groups content into <Section>s with a
// labelled header and optional count/aside. This gives the whole
// console one consistent vertical rhythm instead of each page
// hand-rolling <header>/<h1>/<h2> markup.

import Link from "next/link";
import type { ReactNode } from "react";

import { cx } from "./cx.js";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-subtle">{eyebrow}</p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  count,
  aside,
  tone,
  children,
  className,
}: {
  readonly title?: ReactNode;
  readonly count?: ReactNode;
  readonly aside?: ReactNode;
  readonly tone?: "default" | "warning";
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cx("space-y-3", className)}>
      {title !== undefined ? (
        <header className="flex items-baseline justify-between gap-3">
          <h2
            className={cx(
              "flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em]",
              tone === "warning" ? "text-amber-400" : "text-muted"
            )}
          >
            {title}
            {count !== undefined ? (
              <span className="rounded-full border border-line bg-surface-2 px-1.5 py-px text-[10px] font-semibold text-subtle tabular-nums">
                {count}
              </span>
            ) : null}
          </h2>
          {aside ? <div className="text-xs text-subtle">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Toolbar({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Segmented filter/nav tabs rendered as links (server-friendly). */
export function FilterTabs({
  items,
  className,
}: {
  readonly items: ReadonlyArray<{
    readonly href: string;
    readonly label: ReactNode;
    readonly active: boolean;
  }>;
  readonly className?: string;
}) {
  return (
    <nav
      className={cx(
        "inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1",
        className
      )}
    >
      {items.map((item, i) => (
        <Link
          key={i}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cx(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            item.active
              ? "bg-brand/15 text-fg shadow-xs"
              : "text-muted hover:bg-surface-2 hover:text-fg"
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
