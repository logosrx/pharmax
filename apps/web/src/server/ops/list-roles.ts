// Role / privilege projections — drive `/ops/admin/roles`.
//
// Two readers:
//
//   - `listRolesWithPermissions` — every role in the operator's org
//     with its permission-code set and holder count. Roles per org
//     are bounded (the template clones + a handful of custom ones)
//     so this is a full list.
//
//   - `getRoleDetail` — one role plus its permission codes and the
//     users currently holding it, for the privilege editor page.
//
// PHI: none. Role codes, permission codes, and operator identifiers.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope, type RoleScope } from "@pharmax/database";

export interface RoleListRow {
  readonly roleId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: RoleScope;
  readonly isSystem: boolean;
  readonly permissionCodes: ReadonlyArray<string>;
  readonly userCount: number;
}

export async function listRolesWithPermissions(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<RoleListRow>> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const rows = await tx.role.findMany({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        scope: true,
        isSystem: true,
        rolePermissions: { select: { permission: { select: { code: true } } } },
        _count: { select: { userRoles: true } },
      },
      orderBy: [{ isSystem: "desc" }, { code: "asc" }],
    });

    return rows.map((r) =>
      Object.freeze({
        roleId: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        scope: r.scope,
        isSystem: r.isSystem,
        permissionCodes: r.rolePermissions.map((rp) => rp.permission.code).sort(),
        userCount: r._count.userRoles,
      })
    );
  });
}

export interface RoleHolderRow {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

export interface RoleDetail {
  readonly roleId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: RoleScope;
  readonly isSystem: boolean;
  readonly permissionCodes: ReadonlyArray<string>;
  readonly holders: ReadonlyArray<RoleHolderRow>;
}

export async function getRoleDetail(input: {
  readonly organizationId: string;
  readonly roleId: string;
}): Promise<RoleDetail | null> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const row = await tx.role.findFirst({
      where: { id: input.roleId, organizationId: input.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        scope: true,
        isSystem: true,
        rolePermissions: { select: { permission: { select: { code: true } } } },
        userRoles: {
          select: { user: { select: { id: true, displayName: true, email: true } } },
          distinct: ["userId"],
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (row === null) return null;

    return Object.freeze({
      roleId: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      scope: row.scope,
      isSystem: row.isSystem,
      permissionCodes: row.rolePermissions.map((rp) => rp.permission.code).sort(),
      holders: row.userRoles.map((ur) =>
        Object.freeze({
          userId: ur.user.id,
          displayName: ur.user.displayName,
          email: ur.user.email,
        })
      ),
    });
  });
}
