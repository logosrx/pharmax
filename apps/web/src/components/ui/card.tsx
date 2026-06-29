// Card / Panel — the standard content surface.
//
// `Card` is the elevated container (border + surface + radius). The
// sub-parts give consistent header/body/footer rhythm. `interactive`
// adds a hover lift for clickable cards. `accent` paints a 2px left
// rail in a tone — used by queue rows to signal SLA at a glance.

import Link from "next/link";
import type { ReactNode } from "react";

import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";
import type { Tone } from "./badge.js";

const ACCENT: Record<Tone, string> = {
  neutral: "before:bg-line-strong",
  brand: "before:bg-brand",
  success: "before:bg-emerald-500",
  warning: "before:bg-amber-500",
  danger: "before:bg-red-500",
  info: "before:bg-sky-500",
  violet: "before:bg-violet-500",
  cyan: "before:bg-cyan-500",
};

export interface CardProps {
  readonly className?: string;
  readonly interactive?: boolean;
  readonly accent?: Tone;
  readonly children: ReactNode;
}

export function Card({ className, interactive, accent, children }: CardProps) {
  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-lg border border-line bg-surface shadow-xs",
        accent &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        accent && ACCENT[accent],
        interactive &&
          "transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return <h3 className={cx("text-sm font-semibold text-fg", className)}>{children}</h3>;
}

export function CardContent({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return <div className={cx("px-4 py-4", className)}>{children}</div>;
}

export function CardFooter({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cx("flex items-center gap-2 border-t border-line px-4 py-3", className)}>
      {children}
    </div>
  );
}

/**
 * LinkCard — the ONE canonical clickable list card.
 *
 * Every "row that navigates somewhere" (billing invoice, patient
 * result, report definition, dashboard tile) uses this so they share
 * identical padding, hover lift, optional leading icon tile, optional
 * trailing meta, and a chevron affordance. Pages supply only the
 * middle content; the chrome never drifts.
 */
export function LinkCard({
  href,
  icon,
  end,
  accent,
  chevron = true,
  className,
  children,
}: {
  readonly href: string;
  readonly icon?: IconName;
  readonly end?: ReactNode;
  readonly accent?: Tone;
  readonly chevron?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Link href={href} className="group block rounded-lg focus-visible:outline-none">
      <Card interactive accent={accent} className={className}>
        <div className="flex items-center gap-3 px-4 py-3.5">
          {icon ? (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted transition-colors group-hover:text-fg">
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">{children}</div>
          {end ? <div className="shrink-0 text-right">{end}</div> : null}
          {chevron ? (
            <Icon
              name="chevronRight"
              size={16}
              className="shrink-0 text-subtle transition-colors group-hover:text-fg"
            />
          ) : null}
        </div>
      </Card>
    </Link>
  );
}
