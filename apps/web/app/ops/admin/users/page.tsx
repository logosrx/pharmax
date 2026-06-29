// /ops/admin/users — operator self-serve admin.
//
// Three surfaces: invite teammate (gated users.manage), the team list
// with per-grant rows + revoke (gated roles.manage), and a grant-role
// form per user (role × site). Invited users auto-link on their first
// Clerk sign-in when the primary email matches an INVITED row.
//
// PHI: none. Operator email + name are admin identifiers.

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
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader } from "../../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../src/components/ui/field.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function statusTone(status: string): Tone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "INVITED":
      return "warning";
    case "SUSPENDED":
      return "danger";
    default:
      return "neutral";
  }
}

function UserCard({
  user,
  roles,
  sites,
  canManageRoles,
}: {
  readonly user: OrgUserRow;
  readonly roles: ReadonlyArray<OrgRoleRow>;
  readonly sites: ReadonlyArray<OrgSiteRow>;
  readonly canManageRoles: boolean;
}) {
  const firstRole = roles[0];
  return (
    <Card>
      <CardHeader>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{user.displayName}</span>
            <Badge tone={statusTone(user.status)} dot>
              {user.status}
            </Badge>
            <Badge tone={user.clerkUserId !== null ? "info" : "neutral"}>
              {user.clerkUserId !== null ? "Clerk linked" : "awaiting first sign-in"}
            </Badge>
          </div>
          <div className="text-xs text-subtle">
            <code className="font-mono">{user.email}</code> · joined {formatDate(user.createdAt)}
            {user.lastLoginAt !== null ? <> · last seen {formatDate(user.lastLoginAt)}</> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
            Role grants
          </div>
          {user.grants.length === 0 ? (
            <div className="text-xs text-subtle">No roles granted.</div>
          ) : (
            <ul className="space-y-1.5">
              {user.grants.map((g) => (
                <li
                  key={g.userRoleId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono font-medium text-fg">{g.roleCode}</span>
                    <span className="text-subtle">({g.roleScope})</span>
                    {g.siteId !== null ? (
                      <span className="text-muted">
                        · site <code className="font-mono">{g.siteId.slice(0, 8)}…</code>
                      </span>
                    ) : null}
                    {g.clinicId !== null ? (
                      <span className="text-muted">
                        · clinic <code className="font-mono">{g.clinicId.slice(0, 8)}…</code>
                      </span>
                    ) : null}
                    {g.teamId !== null ? (
                      <span className="text-muted">
                        · team <code className="font-mono">{g.teamId.slice(0, 8)}…</code>
                      </span>
                    ) : null}
                  </div>
                  {canManageRoles ? (
                    <ActionForm action={`/api/ops/admin/users/${user.userId}/revoke-role`}>
                      <input type="hidden" name="userRoleId" value={g.userRoleId} />
                      <SubmitButton variant="danger" size="sm" icon="x">
                        Revoke
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canManageRoles && firstRole !== undefined ? (
          <ActionForm
            action={`/api/ops/admin/users/${user.userId}/assign-role`}
            className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <Field label="Role">
              <Select name="roleCode" defaultValue={firstRole.code}>
                {roles.map((r) => (
                  <option key={r.roleId} value={r.code}>
                    {r.code} ({r.scope})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Site" help="Only for SITE-scoped roles">
              <Select name="siteId" defaultValue="">
                <option value="">— org-wide / n/a —</option>
                {sites.map((s) => (
                  <option key={s.siteId} value={s.siteId}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <SubmitButton icon="plus" className="w-full sm:w-auto">
                Grant role
              </SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
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
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Users" />
        <PermissionDenied grant="users.manage" />
      </div>
    );
  }

  const canManageRoles = hasOperatorPermission(permissions, PERMISSIONS.ROLES_MANAGE);
  const data = await loadOrgAdminPageData({ organizationId: session.tenancy.organizationId });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description="Invite teammates, grant roles, and revoke grants. Invited users link automatically on their first Clerk sign-in when the email matches."
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      <Section title="Invite teammate">
        <Card>
          <CardContent>
            <ActionForm
              action="/api/ops/admin/users/invite"
              className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]"
            >
              <Field label="Email" required>
                <Input
                  type="email"
                  name="email"
                  required
                  autoComplete="off"
                  placeholder="alex@yourpharmacy.com"
                />
              </Field>
              <Field label="Display name" required>
                <Input
                  type="text"
                  name="displayName"
                  required
                  maxLength={120}
                  placeholder="Alex Tech"
                />
              </Field>
              <div className="flex items-end">
                <SubmitButton icon="plus" className="w-full sm:w-auto">
                  Send invite
                </SubmitButton>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </Section>

      <Section title="Team" count={data.users.length}>
        {data.users.length === 0 ? (
          <EmptyState
            icon="users"
            title="No users yet"
            description="Use the invite form above to add your first teammate."
          />
        ) : (
          <div className="space-y-4">
            {data.users.map((u) => (
              <UserCard
                key={u.userId}
                user={u}
                roles={data.roles}
                sites={data.sites}
                canManageRoles={canManageRoles}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
