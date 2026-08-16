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
  brand: "text-tone-brand",
  success: "text-tone-success",
  warning: "text-tone-warning",
  danger: "text-tone-danger",
  info: "text-tone-info",
  violet: "text-tone-violet",
  cyan: "text-tone-cyan",
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
        "card-sheen group rounded-lg border border-line bg-surface p-4 " +
          "transition-[border-color,box-shadow] duration-200 ease-(--ease-out) " +
          "hover:border-line-strong hover:[box-shadow:var(--shadow-edge),var(--shadow-sm)]",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs font-semibold uppercase tracking-caps text-subtle">{label}</p>
        {icon ? (
          <span
            className={cx(
              "flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-2 " +
                "transition-transform duration-200 ease-(--ease-out) group-hover:scale-105",
              STAT_ACCENT[tone]
            )}
          >
            <Icon name={icon} size={14} />
          </span>
        ) : null}
      </div>
      <p
        className={cx(
          "mt-2.5 text-[28px] leading-none font-semibold tracking-tight tabular-nums",
          STAT_ACCENT[tone]
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
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
    <div className="card-sheen overflow-hidden rounded-lg border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className={cx("w-full border-collapse text-sm", className)}>{children}</table>
      </div>
    </div>
  );
}

export function THead({ children }: { readonly children: ReactNode }) {
  return (
    <thead className="border-b border-line bg-surface-2/70">
      <tr>{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  align = "left",
  scope = "col",
  className,
}: {
  readonly children?: ReactNode;
  readonly align?: "left" | "right" | "center";
  /** `col` for THead cells (the default); pass `row` for row headers. */
  readonly scope?: "col" | "row";
  readonly className?: string;
}) {
  return (
    <th
      scope={scope}
      className={cx(
        "px-4 py-2.5 text-2xs font-semibold uppercase tracking-caps text-subtle",
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
  // Column count responds to the list's OWN width (container query),
  // not the viewport — a DataList inside a narrow detail column stays
  // single-column even on a wide screen. @lg ≈ room for 2 columns,
  // @3xl/@4xl ≈ room for 3/4.
  const cols =
    columns === 2
      ? "@lg:grid-cols-2"
      : columns === 4
        ? "@lg:grid-cols-2 @3xl:grid-cols-4"
        : "@lg:grid-cols-2 @3xl:grid-cols-3";
  return (
    <div className={cx("@container", className)}>
      <dl className={cx("grid grid-cols-1 gap-x-6 gap-y-4", cols)}>
        {items.map((item, i) => (
          <div
            key={i}
            className={
              item.span === 2
                ? "@lg:col-span-2"
                : item.span === 3
                  ? "@lg:col-span-2 @3xl:col-span-3"
                  : undefined
            }
          >
            <dt className="text-xs font-medium uppercase tracking-wide text-subtle">
              {item.label}
            </dt>
            <dd className="mt-1 text-sm text-fg">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
