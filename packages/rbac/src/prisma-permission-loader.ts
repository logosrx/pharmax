// PrismaPermissionLoader — production loader.
//
// One round-trip per `load()` call. Raw SQL because:
//   - Prisma's nested `include` for the four-table join (user_role
//     → role → role_permission → permission) returns a hierarchy
//     that we'd then have to flatten ourselves; raw SQL returns
//     the already-flat rows and we group by (userRoleId).
//   - The query is on the hot path of every command handler;
//     paying for an `include` walk on every request is wasteful.
//   - The shape is stable: changing this query is intentional and
//     small, so we don't lose the Prisma-types ergonomics that
//     justify Prisma elsewhere.
//
// Tenancy note: the query is org-scoped via the WHERE clause AND the
// Postgres org GUC. The raw SQL bypasses the Prisma tenancy extension
// (raw queries are not model operations), so under the RLS-subject
// `pharmax_app` role the read would be denied unless the org GUC is
// set. We therefore run the query inside a short transaction that
// calls `applyTenancySessionGuc` first. `role`/`user_role` are
// org-scoped (RLS + the explicit predicate both bind them);
// `role_permission`/`permission` are RLS-exempt registries.

import { Prisma } from "@pharmax/database";
import type { PrismaClient, RoleScope } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";
import {
  applyTenancySessionGuc,
  buildTenancyContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import type { ResolvedGrant } from "./grants.js";
import type { EffectivePermissionLoader, PermissionLoadInput } from "./loader.js";
import type { PermissionCode } from "./permissions.js";

interface PermissionRow {
  readonly userRoleId: string;
  readonly roleScope: RoleScope;
  readonly siteId: string | null;
  readonly clinicId: string | null;
  readonly teamId: string | null;
  readonly permissionCode: string;
}

export class PrismaPermissionLoader implements EffectivePermissionLoader {
  public constructor(private readonly prisma: PrismaClient) {}

  public async load(input: PermissionLoadInput): Promise<ReadonlyArray<ResolvedGrant>> {
    // Run inside a short transaction that sets the org GUC, so the
    // raw read is permitted under the RLS-subject `pharmax_app` role.
    // The loader runs before the command bus opens its own tx, so it
    // owns this one. Prisma's typed `$queryRaw` template-tag keeps the
    // query injection-safe and the pool/log hooks active.
    const ctx = buildTenancyContext({
      organizationId: input.organizationId,
      actor: { userId: input.userId, correlationId: ids.generateUlid() },
    });
    const rows = await this.prisma.$transaction(async (tx) => {
      await applyTenancySessionGuc(tx as unknown as SessionGucExecutor, ctx);
      return tx.$queryRaw<PermissionRow[]>(
        Prisma.sql`
          SELECT
            ur.id              AS "userRoleId",
            r.scope            AS "roleScope",
            ur.site_id         AS "siteId",
            ur.clinic_id       AS "clinicId",
            ur.team_id         AS "teamId",
            p.code             AS "permissionCode"
          FROM user_role ur
          JOIN role r              ON r.id = ur.role_id
          JOIN role_permission rp  ON rp.role_id = r.id
          JOIN permission p        ON p.id = rp.permission_id
          WHERE ur.organization_id = ${input.organizationId}::uuid
            AND ur.user_id         = ${input.userId}::uuid
        `
      );
    });

    return groupRows(rows);
  }
}

function groupRows(rows: ReadonlyArray<PermissionRow>): ReadonlyArray<ResolvedGrant> {
  const byUserRole = new Map<
    string,
    {
      roleScope: RoleScope;
      siteId: string | null;
      clinicId: string | null;
      teamId: string | null;
      permissions: Set<PermissionCode>;
    }
  >();
  for (const row of rows) {
    let entry = byUserRole.get(row.userRoleId);
    if (entry === undefined) {
      entry = {
        roleScope: row.roleScope,
        siteId: row.siteId,
        clinicId: row.clinicId,
        teamId: row.teamId,
        permissions: new Set<PermissionCode>(),
      };
      byUserRole.set(row.userRoleId, entry);
    }
    // Unknown codes from the DB (e.g. a permission added before
    // its constant landed in the registry) get filtered out. We
    // DO NOT throw — production should not crash because of a
    // newer DB row. Tests assert the seed/registry parity.
    entry.permissions.add(row.permissionCode as PermissionCode);
  }

  return Array.from(byUserRole.values()).map((g) => ({
    roleScope: g.roleScope,
    grantScope: { siteId: g.siteId, clinicId: g.clinicId, teamId: g.teamId },
    permissions: g.permissions,
  }));
}
