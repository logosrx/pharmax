// /ops/admin/roles/[roleId] — per-role privilege editor.
//
// Custom roles get a full permission checkbox matrix grouped by
// category; submitting posts the COMPLETE desired set (full
// replacement, matching `UpdateRolePermissions` semantics — what
// you see checked is what the role grants).
//
// Positions (system roles) render the same matrix read-only: their
// permission sets are template-managed, and the page says so instead
// of hiding the data.
//
// PHI: none. Role codes, permission codes, operator identifiers.

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ALL_PERMISSION_CODES,
  PERMISSION_METADATA,
  PERMISSIONS,
  type PermissionCode,
} from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { getRoleDetail } from "../../../../../src/server/ops/list-roles.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Badge } from "../../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

/** Permission codes grouped by their registry category, in registry order. */
function groupedPermissionCatalog(): ReadonlyArray<{
  readonly category: string;
  readonly codes: ReadonlyArray<PermissionCode>;
}> {
  const groups = new Map<string, PermissionCode[]>();
  for (const code of ALL_PERMISSION_CODES) {
    const category = PERMISSION_METADATA[code].category;
    const existing = groups.get(category) ?? [];
    existing.push(code);
    groups.set(category, existing);
  }
  return [...groups.entries()].map(([category, codes]) => ({ category, codes }));
}

function PermissionMatrix({
  granted,
  editable,
}: {
  readonly granted: ReadonlySet<string>;
  readonly editable: boolean;
}) {
  return (
    <div className="space-y-6">
      {groupedPermissionCatalog().map((group) => (
        <div key={group.category} className="space-y-2">
          <div className="text-2xs font-semibold uppercase tracking-wide text-subtle">
            {group.category}
          </div>
          <ul className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
            {group.codes.map((code) => {
              const isGranted = granted.has(code);
              return (
                <li key={code}>
                  <label
                    className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-xs ${
                      isGranted ? "border-accent/40 bg-accent/5" : "border-line bg-surface-2"
                    } ${editable ? "cursor-pointer" : ""}`}
                  >
                    <input
                      type="checkbox"
                      name="permissions"
                      value={code}
                      defaultChecked={isGranted}
                      disabled={!editable}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent,#4f46e5)]"
                    />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block font-mono font-medium text-fg">{code}</span>
                      <span className="block text-subtle">
                        {PERMISSION_METADATA[code].description}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default async function RoleDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly roleId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { roleId } = await params;
  const query = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ROLES_MANAGE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Role" />
        <PermissionDenied grant="roles.manage" />
      </div>
    );
  }

  const role = await getRoleDetail({
    organizationId: session.tenancy.organizationId,
    roleId,
  });
  if (role === null) notFound();

  const granted = new Set(role.permissionCodes);
  const flash = typeof query["flash"] === "string" ? query["flash"] : null;
  const flashError = typeof query["error"] === "string" ? query["error"] : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration · Privileges"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{role.code}</span>
            {role.isSystem ? (
              <Badge tone="neutral">position</Badge>
            ) : (
              <Badge tone="info">custom</Badge>
            )}
          </span>
        }
        description={
          role.description ??
          `${role.name} — ${role.scope} scope, ${role.permissionCodes.length} permissions.`
        }
        actions={
          <Link href="/ops/admin/roles" className={buttonClass({ variant: "secondary" })}>
            All roles
          </Link>
        }
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That change didn't go through">
          {flashError}
        </Banner>
      ) : null}

      {role.isSystem ? (
        <Banner tone="info" title="Template-managed position">
          This is a built-in position; its permission set is managed by the platform templates and
          cannot be edited. Need a variation? Create a custom role starting from this position on
          the Privileges page.
        </Banner>
      ) : null}

      <Section title="Permissions" count={role.permissionCodes.length}>
        <Card>
          <CardContent>
            {role.isSystem ? (
              <PermissionMatrix granted={granted} editable={false} />
            ) : (
              <ActionForm
                action={`/api/ops/admin/roles/${role.roleId}/permissions`}
                className="space-y-6"
              >
                <PermissionMatrix granted={granted} editable={true} />
                <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs text-subtle">
                    Saving applies the checked set exactly — unchecked permissions are revoked for
                    every user holding this role.
                  </p>
                  <SubmitButton icon="check">Save permissions</SubmitButton>
                </div>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section title="Users with this role" count={role.holders.length}>
        {role.holders.length === 0 ? (
          <EmptyState
            icon="users"
            title="Nobody holds this role"
            description="Grant it from the Users page — role changes here will apply to future holders."
          />
        ) : (
          <ul className="space-y-1.5">
            {role.holders.map((h) => (
              <li
                key={h.userId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs"
              >
                <span className="font-medium text-fg">{h.displayName}</span>
                <code className="font-mono text-subtle">{h.email}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
