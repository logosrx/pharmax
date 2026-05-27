// Operator dashboard landing page.
//
// Auth-gated by `proxy.ts` — an unauthenticated visitor is
// redirected to `/sign-in` before this server component renders.
// The component then runs `resolveOperatorTenancyContext` to
// bridge the Clerk session to a Pharmax user + tenancy.
//
// Failure modes render a clear operator-facing message rather than
// throwing:
//   - USER_NOT_LINKED: Clerk session exists, but no Pharmax row
//     links to it. Operator was sign-in'd but never provisioned —
//     shows a "contact your admin" page.
//   - USER_NOT_ACTIVE: linked user is INVITED / SUSPENDED /
//     TERMINATED — shows the same.
//
// This is intentionally a thin "you're in" landing. Real operator
// pages (EMERGENCY queue, reports, billing, scan) land as follow-up
// slices once layout chrome + role-gated nav exists.

import { UserButton } from "@clerk/nextjs";

import {
  RESOLVE_TENANCY_USER_NOT_ACTIVE,
  RESOLVE_TENANCY_USER_NOT_LINKED,
  resolveOperatorTenancyContext,
} from "../src/server/auth/resolve-tenancy.js";

const QUICK_LINKS: ReadonlyArray<{ href: string; label: string; description: string }> = [
  {
    href: "/api/health",
    label: "Health probe",
    description: "Liveness check — public",
  },
];

export default async function DashboardPage() {
  const result = await resolveOperatorTenancyContext();

  if (!result.ok) {
    const reason = result.reason;
    const title =
      reason === RESOLVE_TENANCY_USER_NOT_LINKED
        ? "Account not provisioned"
        : reason === RESOLVE_TENANCY_USER_NOT_ACTIVE
          ? "Account inactive"
          : "Not signed in";
    const body =
      reason === RESOLVE_TENANCY_USER_NOT_LINKED
        ? "Your sign-in is valid, but no Pharmax account is linked to it yet. Contact your organization admin to provision your operator account."
        : reason === RESOLVE_TENANCY_USER_NOT_ACTIVE
          ? "Your Pharmax account is not active. Contact your organization admin."
          : "Sign in to access the operator console.";

    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-8 px-6 py-16">
        <div className="space-y-3 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">Pharmax</p>
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-50">{title}</h1>
          <p className="text-base text-neutral-400">{body}</p>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="/sign-in"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm text-neutral-100 hover:bg-neutral-800"
          >
            Sign in
          </a>
          <UserButton afterSignOutUrl="/sign-in" />
        </div>
      </main>
    );
  }

  const { operator } = result;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-12 px-6 py-16">
      <header className="flex items-start justify-between gap-6">
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">
            Operator Console
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-50">
            Welcome, {operator.displayName}
          </h1>
          <p className="text-sm text-neutral-400">
            Signed in as <code className="text-neutral-200">{operator.email}</code>
          </p>
        </div>
        <UserButton afterSignOutUrl="/sign-in" />
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">Tenancy</h2>
        <dl className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-neutral-500">Organization</dt>
            <dd className="font-mono text-neutral-100">{operator.organizationId}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">User ID</dt>
            <dd className="font-mono text-neutral-100">{operator.userId}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Quick links
        </h2>
        <ul className="space-y-2">
          {QUICK_LINKS.map((link) => (
            <li
              key={link.href}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
            >
              <code className="text-neutral-100">{link.href}</code>
              <span className="text-neutral-500">{link.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="text-xs text-neutral-600">
        Operator console foundation — Phase 5. Workflow / reports / billing UIs land in follow-up
        slices.
      </footer>
    </main>
  );
}
