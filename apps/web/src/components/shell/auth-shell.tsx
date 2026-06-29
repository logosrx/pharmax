// AuthShell — branded frame for the sign-in / sign-up surfaces.
//
// These pages live outside the operator shell, so they bring their own
// chrome: the Pharmax mark, a headline, and a soft brand glow. The
// exported `clerkAppearance` themes Clerk's embedded widgets to match
// the console (brand color, dark surfaces, our radii) so the auth flow
// doesn't look like a bolt-on.

import type { ReactNode } from "react";

import { Icon } from "../ui/icon.js";

export const clerkAppearance = {
  variables: {
    colorPrimary: "#6b66f1",
    colorBackground: "#0f131c",
    colorText: "#e9edf5",
    colorTextSecondary: "#98a4ba",
    colorInputBackground: "#161b27",
    colorInputText: "#e9edf5",
    colorDanger: "#f87171",
    borderRadius: "0.5rem",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    rootBox: "w-full",
    card: "bg-surface border border-line shadow-lg",
    headerTitle: "text-fg",
    headerSubtitle: "text-muted",
    socialButtonsBlockButton: "border border-line-strong bg-surface-2 text-fg",
    formButtonPrimary:
      "bg-brand hover:bg-brand-hover text-brand-fg shadow-sm normal-case text-sm font-medium",
    formFieldInput: "bg-surface-2 border border-line-strong text-fg",
    footerActionLink: "text-brand hover:text-brand-hover",
    footer: "bg-surface",
  },
} as const;

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
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-fg shadow-glow">
            <Icon name="pill" size={24} />
          </span>
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
