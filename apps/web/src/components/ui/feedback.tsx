// Feedback primitives — Banner, EmptyState, PermissionDenied.
//
// Banner replaces the ad-hoc flash/exception divs scattered across
// pages (each had its own emerald/red box). EmptyState gives empty
// queues a calm, intentional look instead of a bare sentence.
// PermissionDenied is the one canonical "you lack grant X" surface.

import type { ReactNode } from "react";

import { cx } from "./cx.js";
import { Icon, type IconName } from "./icon.js";

export type BannerTone = "info" | "success" | "warning" | "danger" | "neutral";

const BANNER_TONES: Record<BannerTone, { box: string; icon: string; glyph: IconName }> = {
  info: {
    box: "border-sky-500/25 bg-sky-500/10 text-sky-100",
    icon: "text-sky-400",
    glyph: "info",
  },
  success: {
    box: "border-emerald-500/25 bg-emerald-500/10 text-emerald-100",
    icon: "text-emerald-400",
    glyph: "check",
  },
  warning: {
    box: "border-amber-500/25 bg-amber-500/10 text-amber-100",
    icon: "text-amber-400",
    glyph: "alert",
  },
  danger: {
    box: "border-red-500/25 bg-red-500/10 text-red-100",
    icon: "text-red-400",
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

export function EmptyState({
  icon = "check",
  title,
  description,
  action,
  className,
}: {
  readonly icon?: IconName;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
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
      {action ? <div className="mt-1">{action}</div> : null}
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
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-fg">
            {grant}
          </code>
          {role ? ` (${role} role).` : "."}
          {children}
        </>
      }
    />
  );
}
