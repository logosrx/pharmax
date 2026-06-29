// Operator-console layout — the application shell.
//
// Server component: it resolves auth + tenancy ONCE, loads the
// operator's effective permissions, computes live queue depth, and
// renders the shell (grouped sidebar + topbar) around every /ops page.
//
//   - Nav items are role-gated against the operator's permission set;
//     empty groups disappear.
//   - Queue-depth badges come from a single cheap COUNT batch.
//   - An unauthenticated visitor never reaches here (bounced by
//     `proxy.ts`); the not-provisioned / inactive states render a
//     calm, branded message instead of throwing.

import { UserButton } from "@clerk/nextjs";
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
import { getQueueCounts } from "../../src/server/ops/get-queue-counts.js";
import { SidebarNav, type NavGroup, type NavLink } from "../../src/components/shell/sidebar-nav.js";
import { OrderSearch } from "../../src/components/shell/order-search.js";
import { ThemeToggle } from "../../src/components/shell/theme-toggle.js";
import { Icon, type IconName } from "../../src/components/ui/icon.js";
import { EmptyState } from "../../src/components/ui/feedback.js";

interface NavSpec {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly requires: PermissionCode | null;
  /** Bucket code(s) whose summed COUNT becomes this item's badge. */
  readonly countCodes?: ReadonlyArray<string>;
}

interface GroupSpec {
  readonly label: string;
  readonly items: ReadonlyArray<NavSpec>;
}

const NAV: ReadonlyArray<GroupSpec> = [
  {
    label: "Workflow",
    items: [
      { href: "/ops", label: "Dashboard", icon: "dashboard", requires: null },
      {
        href: "/ops/typing",
        label: "Typing",
        icon: "typing",
        requires: PERMISSIONS.TYPING_START,
        countCodes: ["INBOX", "TYPING"],
      },
      {
        href: "/ops/pv1",
        label: "PV1 verification",
        icon: "verify",
        requires: PERMISSIONS.PV1_START,
        countCodes: ["PV1"],
      },
      {
        href: "/ops/fill",
        label: "Fill",
        icon: "fill",
        requires: PERMISSIONS.FILL_START,
        countCodes: ["FILL"],
      },
      {
        href: "/ops/final",
        label: "Final verification",
        icon: "final",
        requires: PERMISSIONS.FINAL_START,
        countCodes: ["FINAL"],
      },
    ],
  },
  {
    label: "Fulfillment",
    items: [
      {
        href: "/ops/shipping",
        label: "Shipping",
        icon: "shipping",
        requires: PERMISSIONS.SHIP_RELEASE,
      },
      {
        href: "/ops/shipping/dock",
        label: "Dock capture",
        icon: "dock",
        requires: PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO,
      },
      {
        href: "/ops/shipping/unmatched",
        label: "Unmatched photos",
        icon: "unmatched",
        requires: PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH,
      },
      {
        href: "/ops/emergency",
        label: "Emergency",
        icon: "emergency",
        requires: PERMISSIONS.SHIP_RESOLVE_ESCALATION,
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        href: "/ops/billing",
        label: "Billing",
        icon: "billing",
        requires: PERMISSIONS.BILLING_READ,
      },
      {
        href: "/ops/reports",
        label: "Reports",
        icon: "reports",
        requires: PERMISSIONS.REPORTS_RUN,
      },
      {
        href: "/ops/reports/runs",
        label: "Report history",
        icon: "history",
        requires: PERMISSIONS.REPORTS_RUN,
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        href: "/ops/admin/users",
        label: "Users",
        icon: "users",
        requires: PERMISSIONS.USERS_MANAGE,
      },
      {
        href: "/ops/admin/patients",
        label: "Patients",
        icon: "patients",
        requires: PERMISSIONS.PATIENTS_READ,
      },
      {
        href: "/ops/admin/sites",
        label: "Sites",
        icon: "sites",
        requires: PERMISSIONS.ORG_MANAGE_SITES,
      },
      {
        href: "/ops/admin/carriers",
        label: "Carriers",
        icon: "carriers",
        requires: PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS,
      },
      {
        href: "/ops/admin/report-schedules",
        label: "Report schedules",
        icon: "schedules",
        requires: PERMISSIONS.REPORTS_MANAGE_SCHEDULE,
      },
      {
        href: "/ops/admin/notifications",
        label: "Notifications",
        icon: "notifications",
        requires: PERMISSIONS.NOTIFICATIONS_READ,
      },
      {
        href: "/ops/admin/access-reviews",
        label: "Access reviews",
        icon: "shield",
        requires: PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW,
      },
    ],
  },
];

const COUNT_BUCKET_CODES = ["INBOX", "TYPING", "PV1", "FILL", "FINAL"] as const;

function ShellMessage({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6">
      <EmptyState
        icon="shield"
        title={title}
        description={body}
        action={<UserButton afterSignOutUrl="/sign-in" />}
      />
    </main>
  );
}

export default async function OpsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const result = await resolveOperatorTenancyContext();

  if (!result.ok) {
    const reason = result.reason;
    if (reason === RESOLVE_TENANCY_USER_NOT_LINKED) {
      return (
        <ShellMessage
          title="Account not provisioned"
          body="Your sign-in is valid, but no Pharmax account is linked to it yet. Contact your organization admin to provision your operator account."
        />
      );
    }
    if (reason === RESOLVE_TENANCY_USER_NOT_ACTIVE) {
      return (
        <ShellMessage
          title="Account inactive"
          body="Your Pharmax account is not active. Contact your organization admin."
        />
      );
    }
    return <ShellMessage title="Not signed in" body="Sign in to access the operator console." />;
  }

  const permissions = await loadOperatorPermissions(result.tenancy);
  const counts = await getQueueCounts({
    organizationId: result.tenancy.organizationId,
    bucketCodes: COUNT_BUCKET_CODES,
  });

  const sumCounts = (codes?: ReadonlyArray<string>): number | null => {
    if (codes === undefined) return null;
    let total = 0;
    let any = false;
    for (const code of codes) {
      const c = counts[code];
      if (typeof c === "number") {
        total += c;
        any = true;
      }
    }
    return any ? total : null;
  };

  const groups: NavGroup[] = NAV.map((group) => {
    const items: NavLink[] = group.items
      .filter((it) => it.requires === null || hasOperatorPermission(permissions, it.requires))
      .map((it) => {
        const count = sumCounts(it.countCodes);
        const link: NavLink = { href: it.href, label: it.label, icon: it.icon };
        return count === null ? link : { ...link, count };
      });
    return { label: group.label, items };
  }).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-screen bg-canvas text-fg">
      <SidebarNav groups={groups} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-md sm:px-6">
          <div className="flex items-center gap-2 sm:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-brand-fg">
              <Icon name="pill" size={18} />
            </span>
          </div>
          <OrderSearch />
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-sm font-medium text-fg">{result.operator.displayName}</div>
              <div className="text-[11px] text-subtle">{result.operator.email}</div>
            </div>
            <ThemeToggle />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
