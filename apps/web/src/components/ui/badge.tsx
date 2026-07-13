// Badge / Dot / Kbd — compact status and meta primitives.
//
// `tone` is the vocabulary for every pill in the console. Centralizing
// the tone→class map kills the per-page `statusBadgeClass` /
// `priorityBadgeClass` copy-paste: pages now ask for a tone, and the
// workflow→tone mapping lives in `workflow.ts`.

import type { ReactNode } from "react";

import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";

export type Tone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "violet"
  | "cyan";

const TONES: Record<Tone, string> = {
  neutral: "border-line-strong bg-surface-2 text-muted",
  brand: "border-brand/40 bg-brand/15 text-tone-brand",
  success: "border-emerald-500/30 bg-emerald-500/12 text-tone-success",
  warning: "border-amber-500/30 bg-amber-500/12 text-tone-warning",
  danger: "border-red-500/30 bg-red-500/12 text-tone-danger",
  info: "border-sky-500/30 bg-sky-500/12 text-tone-info",
  violet: "border-violet-500/30 bg-violet-500/12 text-tone-violet",
  cyan: "border-cyan-500/30 bg-cyan-500/12 text-tone-cyan",
};

const DOT_TONES: Record<Tone, string> = {
  neutral: "bg-subtle",
  brand: "bg-brand",
  success: "bg-tone-success-accent",
  warning: "bg-tone-warning-accent",
  danger: "bg-tone-danger-accent",
  info: "bg-tone-info-accent",
  violet: "bg-tone-violet-accent",
  cyan: "bg-tone-cyan-accent",
};

export interface BadgeProps {
  readonly tone?: Tone;
  readonly icon?: IconName;
  readonly dot?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Badge({ tone = "neutral", icon, dot, className, children }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5",
        TONES[tone],
        className
      )}
    >
      {dot ? <span className={cx("h-1.5 w-1.5 rounded-full", DOT_TONES[tone])} /> : null}
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/** A small status dot — optionally pulsing for "live" indicators. */
export function Dot({
  tone = "neutral",
  pulse,
  className,
}: {
  readonly tone?: Tone;
  readonly pulse?: boolean;
  readonly className?: string;
}) {
  return (
    <span className={cx("relative inline-flex h-2 w-2", className)}>
      {pulse ? (
        <span
          className={cx(
            "absolute inline-flex h-full w-full rounded-full opacity-60 animate-pulse-dot",
            DOT_TONES[tone]
          )}
        />
      ) : null}
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", DOT_TONES[tone])} />
    </span>
  );
}

export function Kbd({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong " +
          "bg-surface-2 px-1.5 text-3xs font-medium text-muted shadow-xs",
        className
      )}
    >
      {children}
    </kbd>
  );
}
