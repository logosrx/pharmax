// AuthShell — branded frame for the sign-in / sign-up surfaces.
//
// These pages live outside the operator shell, so they bring their own
// chrome: the Pharmax mark, a headline, and a soft brand glow. The
// forms themselves are ours (ADR-0030 in-house identity); this file
// used to also export a `clerkAppearance` token map for a vendor's
// embedded widgets, which no page has rendered since those widgets
// were removed.

import type { ReactNode } from "react";

import { BrandWordmark } from "./brand.js";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(107,102,241,0.18), transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrandWordmark className="h-8" />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
          </div>
        </div>
        <div className="flex justify-center">{children}</div>
        {footer ? <div className="text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}
