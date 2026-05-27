// /ops/admin/users — operator self-serve admin.
//
// Closes the loop on team onboarding. Three sections:
//
//   - Invite form (gated `users.manage`): admin types email +
//     display name → InviteUser command creates an INVITED row.
//     The teammate signs in via Clerk; resolveOperatorTenancyContext
//     auto-links their Clerk identity by primary email and flips
//     status to ACTIVE on first sign-in.
//
//   - Users list with inline grants: every user in the org with
//     status + clerk-link state + per-grant rows. The "Revoke"
//     button next to each grant fires RevokeUserRole (gated
//     `roles.manage`).
//
//   - "Grant role" form per user: role dropdown × site dropdown.
//     Hidden when no roles are configured (shouldn't happen post-
//     CreateOrganization). The site dropdown is only meaningful
//     for SITE-scoped roles; the route enforces scope rules.
//
// PHI: nothing on this page is patient PHI. Operator email + name
// are admin identifiers.

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  loadOrgAdminPageData,
  type OrgRoleRow,
  type OrgSiteRow,
  type OrgUserRow,
} from "../../../../src/server/ops/list-org-users.js";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "INVITED":
      return "border-amber-700 bg-amber-950 text-amber-200";
    case "SUSPENDED":
      return "border-red-700 bg-red-950 text-red-200";
    case "TERMINATED":
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
  }
}

interface UserCardProps {
  readonly user: OrgUserRow;
  readonly roles: ReadonlyArray<OrgRoleRow>;
  readonly sites: ReadonlyArray<OrgSiteRow>;
  readonly canManageRoles: boolean;
}

function UserCard({ user, roles, sites, canManageRoles }: UserCardProps) {
  const firstRole = roles[0];
  return (
    <li className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-100">{user.displayName}</span>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${statusBadgeClass(
                user.status
              )}`}
            >
              {user.status}
            </span>
            {user.clerkUserId !== null ? (
              <span className="inline-flex items-center rounded-md border border-blue-800 bg-blue-950 px-2 py-0.5 text-xs text-blue-200">
                Clerk linked
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400">
                awaiting first sign-in
              </span>
            )}
          </div>
          <div className="text-xs text-neutral-500">
            <code className="font-mono">{user.email}</code> · joined {formatDate(user.createdAt)}
            {user.lastLoginAt !== null ? <> · last seen {formatDate(user.lastLoginAt)}</> : null}
          </div>
        </div>
      </header>

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-neutral-500">Role grants</div>
        {user.grants.length === 0 ? (
          <div className="text-xs text-neutral-500">No roles granted.</div>
        ) : (
          <ul className="space-y-1">
            {user.grants.map((g) => (
              <li
                key={g.userRoleId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs"
              >
                <div className="space-x-1">
                  <span className="font-mono text-neutral-100">{g.roleCode}</span>
                  <span className="text-neutral-500">({g.roleScope})</span>
                  {g.siteId !== null ? (
                    <span className="text-neutral-400">
                      · site <code className="font-mono">{g.siteId.slice(0, 8)}…</code>
                    </span>
                  ) : null}
                  {g.clinicId !== null ? (
                    <span className="text-neutral-400">
                      · clinic <code className="font-mono">{g.clinicId.slice(0, 8)}…</code>
                    </span>
                  ) : null}
                  {g.teamId !== null ? (
                    <span className="text-neutral-400">
                      · team <code className="font-mono">{g.teamId.slice(0, 8)}…</code>
                    </span>
                  ) : null}
                </div>
                {canManageRoles ? (
                  <form action={`/api/ops/admin/users/${user.userId}/revoke-role`} method="POST">
                    <input type="hidden" name="userRoleId" value={g.userRoleId} />
                    <button
                      type="submit"
                      className="rounded-md border border-red-800 bg-red-950 px-2 py-0.5 text-xs text-red-200 hover:bg-red-900"
                    >
                      Revoke
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManageRoles && firstRole !== undefined ? (
        <form
          action={`/api/ops/admin/users/${user.userId}/assign-role`}
          method="POST"
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        >
          <label className="space-y-1 text-xs text-neutral-500">
            Role
            <select
              name="roleCode"
              defaultValue={firstRole.code}
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
            >
              {roles.map((r) => (
                <option key={r.roleId} value={r.code}>
                  {r.code} ({r.scope})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-neutral-500">
            Site (only for SITE-scope roles)
            <select
              name="siteId"
              defaultValue=""
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
            >
              <option value="">— org-wide / not applicable —</option>
              {sites.map((s) => (
                <option key={s.siteId} value={s.siteId}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="self-end">
            <button
              type="submit"
              className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
            >
              Grant role
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export default async function UserAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.USERS_MANAGE)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Users</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to manage users. Contact your admin to request{" "}
          <code className="text-neutral-200">users.manage</code>.
        </p>
      </main>
    );
  }

  const canManageRoles = hasOperatorPermission(permissions, PERMISSIONS.ROLES_MANAGE);
  const data = await loadOrgAdminPageData({
    organizationId: session.tenancy.organizationId,
  });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Users</h1>
        <p className="text-sm text-neutral-400">
          Invite teammates, grant roles, and revoke grants. Invited users link automatically on
          their first Clerk sign-in if the primary email matches an INVITED row in this
          organization.
        </p>
      </header>

      {flash !== null ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {flash}
        </div>
      ) : null}
      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Invite teammate
        </h2>
        <form
          action="/api/ops/admin/users/invite"
          method="POST"
          className="grid grid-cols-1 gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-4 sm:grid-cols-3"
        >
          <label className="space-y-1 text-xs text-neutral-500">
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="off"
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              placeholder="alex@yourpharmacy.com"
            />
          </label>
          <label className="space-y-1 text-xs text-neutral-500">
            Display name
            <input
              type="text"
              name="displayName"
              required
              maxLength={120}
              className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              placeholder="Alex Tech"
            />
          </label>
          <div className="self-end">
            <button
              type="submit"
              className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
            >
              Send invite
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Team ({data.users.length})
        </h2>
        {data.users.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            No users. Use the invite form above.
          </div>
        ) : (
          <ul className="space-y-4">
            {data.users.map((u) => (
              <UserCard
                key={u.userId}
                user={u}
                roles={data.roles}
                sites={data.sites}
                canManageRoles={canManageRoles}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
