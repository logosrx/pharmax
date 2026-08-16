// Feedback primitives — Banner, PermissionDenied.
//
// Banner replaces the ad-hoc flash/exception divs scattered across
// pages (each had its own emerald/red box). PermissionDenied is the
// one canonical "you lack grant X" surface. EmptyState lives in
// `empty-state.tsx` (with its ErrorState sibling) and is re-exported
// here so existing imports keep working.

import type { ReactNode } from "react";

import { cx } from "./cx.js";
import { EmptyState } from "./empty-state.js";
import { Icon, type IconName } from "./icon.js";

export { EmptyState } from "./empty-state.js";
export { ErrorState } from "./empty-state.js";

export type BannerTone = "info" | "success" | "warning" | "danger" | "neutral";

const BANNER_TONES: Record<BannerTone, { box: string; icon: string; glyph: IconName }> = {
  info: {
    box: "border-sky-500/25 bg-sky-500/10 text-tone-info-strong",
    icon: "text-tone-info-accent",
    glyph: "info",
  },
  success: {
    box: "border-emerald-500/25 bg-emerald-500/10 text-tone-success-strong",
    icon: "text-tone-success-accent",
    glyph: "check",
  },
  warning: {
    box: "border-amber-500/25 bg-amber-500/10 text-tone-warning-strong",
    icon: "text-tone-warning-accent",
    glyph: "alert",
  },
  danger: {
    box: "border-red-500/25 bg-red-500/10 text-tone-danger-strong",
    icon: "text-tone-danger-accent",
    glyph: "alert",
  },
  neutral: {
    box: "border-line bg-surface-2 text-fg",
    icon: "text-muted",
    glyph: "info",
  },
};

export function Banner({
  tone = "info",
  title,
  icon,
  children,
  className,
}: {
  readonly tone?: BannerTone;
  readonly title?: ReactNode;
  readonly icon?: IconName;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const t = BANNER_TONES[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cx(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm animate-fade-in",
        t.box,
        className
      )}
    >
      <Icon name={icon ?? t.glyph} size={18} className={cx("mt-0.5", t.icon)} />
      <div className="min-w-0 space-y-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-current/90 [&_code]:font-mono">{children}</div> : null}
      </div>
    </div>
  );
}

export function PermissionDenied({
  grant,
  role,
  children,
}: {
  readonly grant: string;
  readonly role?: string;
  readonly children?: ReactNode;
}) {
  return (
    <EmptyState
      icon="shield"
      title="You don't have access to this area"
      description={
        <>
          Ask your organization admin to grant{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-2xs text-fg">
            {grant}
          </code>
          {role ? ` (${role} role).` : "."}
          {children}
        </>
      }
    />
  );
}
