// Data display primitives — Stat (KPI), Table set, DataList.
//
// Stat powers dashboard/queue KPIs. The Table parts give every list
// the same header treatment, row hover, zebra-free clean lines, and
// right-alignable numeric cells. DataList is the canonical key/value
// grid used by order-detail and admin record views.

import type { ReactNode } from "react";

import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";
import type { Tone } from "./badge.js";

const STAT_ACCENT: Record<Tone, string> = {
  neutral: "text-muted",
  brand: "text-iris-300",
  success: "text-emerald-300",
  warning: "text-amber-300",
  danger: "text-red-300",
  info: "text-sky-300",
  violet: "text-violet-300",
  cyan: "text-cyan-300",
};

export function Stat({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
  className,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly icon?: IconName;
  readonly tone?: Tone;
  readonly className?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-lg border border-line bg-surface p-4 shadow-xs transition-colors hover:border-line-strong",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</p>
        {icon ? <Icon name={icon} size={16} className={STAT_ACCENT[tone]} /> : null}
      </div>
      <p
        className={cx("mt-2 text-3xl font-semibold tracking-tight tabular-nums", STAT_ACCENT[tone])}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Table({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className={cx("w-full border-collapse text-sm", className)}>{children}</table>
      </div>
    </div>
  );
}

export function THead({ children }: { readonly children: ReactNode }) {
  return (
    <thead className="border-b border-line bg-surface-2">
      <tr>{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  align = "left",
  className,
}: {
  readonly children?: ReactNode;
  readonly align?: "left" | "right" | "center";
  readonly className?: string;
}) {
  return (
    <th
      className={cx(
        "px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-subtle",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className
      )}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { readonly children: ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <tr className={cx("transition-colors hover:bg-surface-2/60", className)}>{children}</tr>;
}

export function TD({
  children,
  align = "left",
  className,
}: {
  readonly children?: ReactNode;
  readonly align?: "left" | "right" | "center";
  readonly className?: string;
}) {
  return (
    <td
      className={cx(
        "px-4 py-3 text-fg align-middle",
        align === "right" && "text-right tabular-nums",
        align === "center" && "text-center",
        className
      )}
    >
      {children}
    </td>
  );
}

/** Key/value grid for record detail views. */
export function DataList({
  items,
  columns = 3,
  className,
}: {
  readonly items: ReadonlyArray<{
    readonly label: ReactNode;
    readonly value: ReactNode;
    readonly span?: number;
  }>;
  readonly columns?: 2 | 3 | 4;
  readonly className?: string;
}) {
  const cols =
    columns === 2
      ? "sm:grid-cols-2"
      : columns === 4
        ? "sm:grid-cols-2 lg:grid-cols-4"
        : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <dl className={cx("grid grid-cols-1 gap-x-6 gap-y-4", cols, className)}>
      {items.map((item, i) => (
        <div
          key={i}
          className={
            item.span === 2
              ? "sm:col-span-2"
              : item.span === 3
                ? "sm:col-span-2 lg:col-span-3"
                : undefined
          }
        >
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">{item.label}</dt>
          <dd className="mt-1 text-sm text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
