// Operator-console layout.
//
// Wraps every `/ops/*` page with a left sidebar nav + a topbar
// carrying the operator's identity (UserButton).
//
// Auth + tenancy resolution happens HERE (server component) so:
//   - Every nested page can rely on the tenancy already being
//     resolved (no per-page duplication).
//   - The sidebar's nav items are role-gated against the
//     operator's effective permission set.
//   - An unauthenticated visitor never sees the chrome — they're
//     bounced by `proxy.ts` before this component renders.
//
// Pages still call `resolveOperatorTenancyContext` themselves
// when they need the resolved tenancy (server components in
// Next.js layouts can't pass values to nested route segments
// without React context, and we deliberately don't introduce a
// client-side auth provider here — the operator session is
// server-side state).

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";

import { PERMISSIONS, type PermissionCode } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../src/server/auth/operator-permissions.js";
import {
  RESOLVE_TENANCY_USER_NOT_ACTIVE,
  RESOLVE_TENANCY_USER_NOT_LINKED,
  resolveOperatorTenancyContext,
} from "../../src/server/auth/resolve-tenancy.js";

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly requires: PermissionCode | null;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/", label: "Dashboard", requires: null },
  { href: "/ops/typing", label: "Typing queue", requires: PERMISSIONS.TYPING_START },
  { href: "/ops/pv1", label: "PV1 queue", requires: PERMISSIONS.PV1_START },
  { href: "/ops/fill", label: "Fill queue", requires: PERMISSIONS.FILL_START },
  { href: "/ops/final", label: "Final verification", requires: PERMISSIONS.FINAL_START },
  { href: "/ops/shipping", label: "Shipping queue", requires: PERMISSIONS.SHIP_RELEASE },
  {
    href: "/ops/shipping/dock",
    label: "Shipping · Dock capture",
    requires: PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO,
  },
  {
    href: "/ops/shipping/unmatched",
    label: "Shipping · Unmatched photos",
    requires: PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH,
  },
  {
    href: "/ops/emergency",
    label: "Emergency queue",
    requires: PERMISSIONS.SHIP_RESOLVE_ESCALATION,
  },
  { href: "/ops/billing", label: "Billing", requires: PERMISSIONS.BILLING_READ },
  { href: "/ops/reports", label: "Reports", requires: PERMISSIONS.REPORTS_RUN },
  { href: "/ops/reports/runs", label: "Reports · History", requires: PERMISSIONS.REPORTS_RUN },
  {
    href: "/ops/admin/users",
    label: "Admin · Users",
    requires: PERMISSIONS.USERS_MANAGE,
  },
  {
    href: "/ops/admin/patients",
    label: "Admin · Patients",
    requires: PERMISSIONS.PATIENTS_READ,
  },
  {
    href: "/ops/admin/sites",
    label: "Admin · Sites",
    requires: PERMISSIONS.ORG_MANAGE_SITES,
  },
  {
    href: "/ops/admin/carriers",
    label: "Admin · Carriers",
    requires: PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS,
  },
  {
    href: "/ops/admin/report-schedules",
    label: "Admin · Report schedules",
    requires: PERMISSIONS.REPORTS_MANAGE_SCHEDULE,
  },
  {
    href: "/ops/admin/notifications",
    label: "Admin · Notifications",
    requires: PERMISSIONS.NOTIFICATIONS_READ,
  },
];

export default async function OpsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const result = await resolveOperatorTenancyContext();

  if (!result.ok) {
    const reason = result.reason;
    const title =
      reason === RESOLVE_TENANCY_USER_NOT_LINKED
        ? "Account not provisioned"
        : reason === RESOLVE_TENANCY_USER_NOT_ACTIVE
          ? "Account inactive"
          : "Not signed in";
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-neutral-50">{title}</h1>
        <p className="text-neutral-400">
          Contact your organization admin if you believe this is an error.
        </p>
        <UserButton afterSignOutUrl="/sign-in" />
      </main>
    );
  }

  const permissions = await loadOperatorPermissions(result.tenancy);
  const visibleNav = NAV_ITEMS.filter(
    (item) => item.requires === null || hasOperatorPermission(permissions, item.requires)
  );

  return (
    <div className="flex min-h-screen bg-neutral-950 text-neutral-100">
      <aside className="hidden w-60 flex-col border-r border-neutral-800 bg-neutral-950 p-4 sm:flex">
        <div className="mb-6 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
          Pharmax Ops
        </div>
        <nav className="flex flex-col gap-1">
          {visibleNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-50"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
          <div className="text-sm text-neutral-400">
            Signed in as <span className="text-neutral-100">{result.operator.displayName}</span>
          </div>
          <UserButton afterSignOutUrl="/sign-in" />
        </header>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}
