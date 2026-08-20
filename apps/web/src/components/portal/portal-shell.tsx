// Shared chrome for signed-in provider-portal pages (ADR-0033,
// slice 3): header with brand + sign-out, and the section nav. Server
// component — session gating happens in each page before rendering.

import Link from "next/link";

import type { PortalIdentityScoped } from "../../server/portal/current-session.js";
import { BrandWordmark } from "../shell/brand.js";
import { PortalSignOutButton } from "./portal-sign-out-button.js";

export type PortalNavKey = "home" | "orders" | "profile" | "settings";

const NAV_ITEMS: ReadonlyArray<{ key: PortalNavKey; href: string; label: string }> = [
  { key: "home", href: "/portal", label: "Overview" },
  { key: "orders", href: "/portal/orders", label: "Orders" },
  { key: "profile", href: "/portal/profile", label: "Profile" },
  { key: "settings", href: "/portal/settings", label: "Settings" },
];

export function PortalShell({
  active,
  identity,
  children,
}: {
  readonly active: PortalNavKey;
  /**
   * Present on every data-bearing page. Drives the client indicator: a
   * prescriber who writes for several practices must be able to see at
   * a glance which one they are acting as, because it decides what this
   * page is showing them and which practice gets invoiced.
   */
  readonly identity?: PortalIdentityScoped;
  readonly children: React.ReactNode;
}) {
  const canSwitch = identity !== undefined && identity.clinicOptions.length > 1;

  return (
    <main className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <BrandWordmark className="h-5" />
            <span className="border-l border-line pl-3 text-sm font-semibold text-fg">
              Provider portal
            </span>
          </div>
          <div className="flex items-center gap-3">
            {identity !== undefined ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-muted">Acting for</span>
                <span className="rounded-full border border-line px-2.5 py-0.5 font-medium text-fg">
                  {identity.activeClinic.name}
                </span>
                {canSwitch ? (
                  <Link
                    href="/portal/select-client"
                    className="text-brand underline underline-offset-2 hover:no-underline"
                  >
                    Switch
                  </Link>
                ) : null}
              </span>
            ) : null}
            <PortalSignOutButton />
          </div>
        </div>
        <nav aria-label="Portal" className="mx-auto flex max-w-3xl gap-1 px-4">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === active ? "page" : undefined}
              className={
                item.key === active
                  ? "border-b-2 border-brand px-3 py-2 text-sm font-medium text-fg"
                  : "border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-fg"
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">{children}</div>
    </main>
  );
}
