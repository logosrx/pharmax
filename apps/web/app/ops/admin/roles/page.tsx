// /ops/admin/roles — privileges administration.
//
// Two role families:
//   - Positions: system roles cloned from `ROLE_TEMPLATES` at org
//     creation. Their permission sets are template-managed and
//     rendered read-only here.
//   - Custom roles: org-local privilege sets minted via `CreateRole`
//     and edited per-permission on the detail page.
//
// The create form can start from a position preset (copies that
// template's permission set) or blank; either way the admin lands on
// the editor page to fine-tune.
//
// PHI: none. Role codes + permission codes only.

import Link from "next/link";
import { PERMISSIONS, ROLE_TEMPLATES } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listRolesWithPermissions,
  type RoleListRow,
} from "../../../../src/server/ops/list-roles.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../src/components/ui/field.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

const HUMAN_PRESETS = ROLE_TEMPLATES.filter((t) => !t.name.includes("(machine)"));

function RoleTable({ roles }: { readonly roles: ReadonlyArray<RoleListRow> }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Role</TH>
          <TH>Scope</TH>
          <TH className="text-right">Permissions</TH>
          <TH className="text-right">Users</TH>
          <TH className="sr-only">Open</TH>
        </TR>
      </THead>
      <TBody>
        {roles.map((r) => (
          <TR key={r.roleId}>
            <TD>
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/ops/admin/roles/${r.roleId}`}
                    className="font-mono text-sm font-medium text-fg hover:underline"
                  >
                    {r.code}
                  </Link>
                  {r.isSystem ? (
                    <Badge tone="neutral">position</Badge>
                  ) : (
                    <Badge tone="info">custom</Badge>
                  )}
                </div>
                <div className="text-xs text-subtle">{r.name}</div>
              </div>
            </TD>
            <TD>
              <span className="text-xs text-muted">{r.scope}</span>
            </TD>
            <TD className="text-right tabular-nums">{r.permissionCodes.length}</TD>
            <TD className="text-right tabular-nums">{r.userCount}</TD>
            <TD className="text-right">
              <Link
                href={`/ops/admin/roles/${r.roleId}`}
                className="text-xs font-medium text-accent hover:underline"
              >
                {r.isSystem ? "View" : "Edit"}
              </Link>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function RolesAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ROLES_MANAGE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Privileges" />
        <PermissionDenied grant="roles.manage" />
      </div>
    );
  }

  const roles = await listRolesWithPermissions({
    organizationId: session.tenancy.organizationId,
  });
  const positions = roles.filter((r) => r.isSystem);
  const custom = roles.filter((r) => !r.isSystem);
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Privileges"
        description="Positions carry template-managed permission sets. Custom roles let you compose an exact privilege set — start from a position or from scratch, then fine-tune per permission."
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      <Section title="Create custom role">
        <Card>
          <CardContent>
            <ActionForm
              action="/api/ops/admin/roles/create"
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]"
            >
              <Field label="Code" required help="Unique identifier, e.g. NightShiftLead">
                <Input
                  type="text"
                  name="code"
                  required
                  maxLength={64}
                  pattern="[A-Za-z][A-Za-z0-9_\-]{1,63}"
                  placeholder="NightShiftLead"
                />
              </Field>
              <Field label="Name" required>
                <Input
                  type="text"
                  name="name"
                  required
                  maxLength={120}
                  placeholder="Night Shift Lead"
                />
              </Field>
              <Field label="Scope">
                <Select name="scope" defaultValue="ORGANIZATION">
                  <option value="ORGANIZATION">Organization-wide</option>
                  <option value="SITE">Per site</option>
                  <option value="CLINIC">Per clinic</option>
                  <option value="TEAM">Per team</option>
                </Select>
              </Field>
              <Field label="Start from position" help="Copies that position's permissions">
                <Select name="preset" defaultValue="">
                  <option value="">— blank —</option>
                  {HUMAN_PRESETS.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.name} ({t.permissions.length} permissions)
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <SubmitButton icon="plus" className="w-full sm:w-auto">
                  Create role
                </SubmitButton>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </Section>

      <Section title="Custom roles" count={custom.length}>
        {custom.length === 0 ? (
          <EmptyState
            icon="key"
            title="No custom roles yet"
            description="Create one above to compose a privilege set beyond the built-in positions."
          />
        ) : (
          <RoleTable roles={custom} />
        )}
      </Section>

      <Section title="Positions" count={positions.length}>
        <RoleTable roles={positions} />
      </Section>
    </div>
  );
}
