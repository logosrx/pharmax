// Shared chrome for signed-in provider-portal pages (ADR-0033,
// slice 3): header with brand + sign-out, and the section nav. Server
// component — session gating happens in each page before rendering.

import Link from "next/link";

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
  children,
}: {
  readonly active: PortalNavKey;
  readonly children: React.ReactNode;
}) {
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
          <PortalSignOutButton />
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-4">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
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
