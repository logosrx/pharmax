// Button — the single source of truth for actionable controls.
//
// Exposes `buttonClass()` (so `<Link>`, `<a>`, and bare
// `<button type="submit">` inside server-action forms can all share
// the exact same look) and a `<Button>` convenience wrapper.
//
// Variants encode INTENT, not color, so the workflow reads
// consistently: `primary` = the main move, `go` = advance the
// workflow (approve/complete), `danger` = reject/destructive,
// `secondary`/`ghost` = supporting, `subtle` = low-emphasis.

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";

export type ButtonVariant =
  "primary" | "secondary" | "ghost" | "danger" | "go" | "subtle" | "outline";

export type ButtonSize = "sm" | "md" | "lg" | "icon";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 " +
  "ease-(--ease-out) " +
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 select-none";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    // Hairline top-light + contact shadow: reads as a machined key,
    // not a flat fill. The inset highlight rides on brand-fg white.
    "bg-brand text-brand-fg border border-transparent " +
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_3px_rgb(0_0_0/0.28)] " +
    "hover:bg-brand-hover hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_4px_14px_-2px_color-mix(in_oklab,var(--brand)_55%,transparent)]",
  go:
    "border border-emerald-500/30 bg-emerald-500/15 text-tone-success-strong " +
    "hover:bg-emerald-500/25 hover:border-emerald-500/45",
  danger:
    "border border-red-500/30 bg-red-500/15 text-tone-danger-strong " +
    "hover:bg-red-500/25 hover:border-red-500/45",
  secondary:
    "border border-line-strong bg-surface-2 text-fg hover:bg-surface-3 hover:border-subtle/60",
  outline: "border border-line-strong bg-transparent text-fg hover:bg-surface-2",
  ghost: "border border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-fg",
  subtle: "border border-transparent bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-9 w-9 p-0",
};

export function buttonClass(opts?: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
}): string {
  return cx(BASE, VARIANTS[opts?.variant ?? "primary"], SIZES[opts?.size ?? "md"], opts?.className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  readonly iconRight?: IconName;
  readonly children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...rest}>
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === "sm" ? 14 : 16} /> : null}
    </button>
  );
}
