// Org-user admin projection — drives `/ops/admin/users`.
//
// Returns one row per Pharmax `user` in the operator's org, with
// joined role grants per user (so the page can render
// "Pharmacist (site-A), BillingManager (org-wide), …" inline
// without a per-row N+1).
//
// PHI: email + displayName are operator identifiers, NOT patient
// PHI. Safe to log + display.

import "server-only";

import { readInOrgScope, type RoleScope, type UserStatus } from "@pharmax/database";

export interface OrgUserGrant {
  readonly userRoleId: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly roleScope: RoleScope;
  readonly siteId: string | null;
  readonly clinicId: string | null;
  readonly teamId: string | null;
}

export interface OrgUserRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly clerkUserId: string | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly grants: ReadonlyArray<OrgUserGrant>;
}

export interface OrgRoleRow {
  readonly roleId: string;
  readonly code: string;
  readonly name: string;
  readonly scope: RoleScope;
  readonly isSystem: boolean;
}

export interface OrgSiteRow {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
}

export interface OrgAdminPageData {
  readonly users: ReadonlyArray<OrgUserRow>;
  readonly roles: ReadonlyArray<OrgRoleRow>;
  readonly sites: ReadonlyArray<OrgSiteRow>;
}

export async function loadOrgAdminPageData(input: {
  readonly organizationId: string;
}): Promise<OrgAdminPageData> {
  return readInOrgScope(input.organizationId, async (tx) => {
    // Sequential (not Promise.all) because these run inside one
    // interactive transaction on a single connection.
    const users = await tx.user.findMany({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        clerkUserId: true,
        lastLoginAt: true,
        createdAt: true,
        userRoles: {
          select: {
            id: true,
            roleId: true,
            siteId: true,
            clinicId: true,
            teamId: true,
            role: { select: { code: true, name: true, scope: true } },
          },
        },
      },
      orderBy: [{ status: "asc" }, { email: "asc" }],
    });
    const roles = await tx.role.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, code: true, name: true, scope: true, isSystem: true },
      orderBy: [{ scope: "asc" }, { code: "asc" }],
    });
    const sites = await tx.pharmacySite.findMany({
      where: { organizationId: input.organizationId, status: "ACTIVE" },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });

    return Object.freeze({
      users: users.map((u) =>
        Object.freeze({
          userId: u.id,
          email: u.email,
          displayName: u.displayName,
          status: u.status,
          clerkUserId: u.clerkUserId,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
          grants: u.userRoles.map((g) =>
            Object.freeze({
              userRoleId: g.id,
              roleId: g.roleId,
              roleCode: g.role.code,
              roleName: g.role.name,
              roleScope: g.role.scope,
              siteId: g.siteId,
              clinicId: g.clinicId,
              teamId: g.teamId,
            })
          ),
        })
      ),
      roles: roles.map((r) =>
        Object.freeze({
          roleId: r.id,
          code: r.code,
          name: r.name,
          scope: r.scope,
          isSystem: r.isSystem,
        })
      ),
      sites: sites.map((s) => Object.freeze({ siteId: s.id, code: s.code, name: s.name })),
    });
  });
}
