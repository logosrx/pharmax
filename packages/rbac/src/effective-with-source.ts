// Effective permissions with source attribution.
//
// `requirePermission` returns yes/no. The admin role editor needs
// more: "WHY does user X have permission Y here, and what would
// I have to change to take it away?" That question requires keeping
// the audit trail of WHERE each permission came from:
//
//   - `role_default`   — comes from one of the user's role grants.
//   - `override_granted` — explicit per-user grant on top of role.
//   - `override_revoked` — explicit per-user revocation on top of role.
//   - `not_available` — not in any of the user's roles and not overridden.
//
// This view is READ-ONLY. It is never used to make access decisions:
// the security path is always `requirePermission`. Both helpers
// resolve through the SAME loader/cache so they always agree.
//
// PHI invariant: NOTHING in the result references patient data. The
// emitted records contain permission codes, role identifiers, and
// override identifiers — all staff-administration artifacts.

import { tenancy } from "@pharmax/tenancy";

import { getRbacConfiguration } from "./configure.js";
import { appliesInContext, type ResolvedGrant } from "./grants.js";
import { ALL_PERMISSION_CODES, PERMISSION_METADATA, type PermissionCode } from "./permissions.js";

/** Where the effective decision for a given permission came from. */
export type PermissionSource =
  | "role_default"
  | "override_granted"
  | "override_revoked"
  | "not_available";

export interface PermissionWithSource {
  readonly permission: PermissionCode;
  readonly granted: boolean;
  readonly source: PermissionSource;
  /**
   * Best-effort attribution. For `role_default`, lists the roles
   * (by `roleScope` and grant-pin) that supplied the permission.
   * For `override_*`, lists the override identifier so the admin
   * UI can deep-link to the override row.
   */
  readonly attribution: ReadonlyArray<{
    readonly kind: "role" | "override";
    readonly label: string;
  }>;
}

/**
 * Optional source of per-user overrides on top of role grants. The
 * loader returns "granted" and "revoked" sets for the active user.
 * When no override source is configured we treat both sets as empty.
 *
 * Like the permission loader, this is an interface so production
 * (Prisma-backed) and tests (in-memory) can swap freely. The
 * concrete Prisma-backed implementation lands with the override
 * schema migration.
 */
export interface PermissionOverrideSource {
  load(input: { readonly organizationId: string; readonly userId: string }): Promise<{
    readonly granted: ReadonlySet<PermissionCode>;
    readonly revoked: ReadonlySet<PermissionCode>;
  }>;
}

/** No-op override source. Used when the platform has no overrides wired yet. */
export class EmptyPermissionOverrideSource implements PermissionOverrideSource {
  public async load(): Promise<{
    readonly granted: ReadonlySet<PermissionCode>;
    readonly revoked: ReadonlySet<PermissionCode>;
  }> {
    return { granted: new Set(), revoked: new Set() };
  }
}

/**
 * Returns the FULL permission registry annotated with the effective
 * decision AND attribution for the active actor + context.
 *
 * Ordering of resolution (the order is important — last wins):
 *   1. `not_available` for every permission.
 *   2. For each applicable role grant, mark its permissions
 *      `role_default + granted`.
 *   3. Apply `override_granted`.
 *   4. Apply `override_revoked` (revocations always win over both
 *      role defaults and grant overrides — revocation is the most
 *      explicit administrative act).
 *
 * Step 4's precedence is intentional: an admin who explicitly
 * revokes a permission expects it to stay revoked even if the user's
 * role would otherwise supply it. To re-enable, the admin must
 * delete the revocation override.
 */
export async function getEffectivePermissionsWithSource(
  overrideSource?: PermissionOverrideSource
): Promise<ReadonlyArray<PermissionWithSource>> {
  const ctx = tenancy.requireCurrentContext();
  const config = getRbacConfiguration();
  const grants = await config.loader.load({
    organizationId: ctx.organizationId,
    userId: ctx.actor.userId,
  });
  const applicable = grants.filter((g) => appliesInContext(g, ctx));

  const overrides = await (overrideSource ?? new EmptyPermissionOverrideSource()).load({
    organizationId: ctx.organizationId,
    userId: ctx.actor.userId,
  });

  // Build the per-permission decision and attribution.
  const out: PermissionWithSource[] = [];
  for (const code of ALL_PERMISSION_CODES) {
    out.push(buildEntry(code, applicable, overrides));
  }
  return out;
}

function buildEntry(
  permission: PermissionCode,
  applicableGrants: ReadonlyArray<ResolvedGrant>,
  overrides: {
    readonly granted: ReadonlySet<PermissionCode>;
    readonly revoked: ReadonlySet<PermissionCode>;
  }
): PermissionWithSource {
  const fromRoles = applicableGrants.filter((g) => g.permissions.has(permission));
  const grantedByRole = fromRoles.length > 0;
  const overrideGranted = overrides.granted.has(permission);
  const overrideRevoked = overrides.revoked.has(permission);

  // Revocation wins.
  if (overrideRevoked) {
    return {
      permission,
      granted: false,
      source: "override_revoked",
      attribution: [{ kind: "override", label: "override:revoked" }],
    };
  }
  if (overrideGranted) {
    return {
      permission,
      granted: true,
      source: "override_granted",
      attribution: [{ kind: "override", label: "override:granted" }],
    };
  }
  if (grantedByRole) {
    return {
      permission,
      granted: true,
      source: "role_default",
      attribution: fromRoles.map((g) => ({
        kind: "role" as const,
        label: roleLabel(g),
      })),
    };
  }
  return {
    permission,
    granted: false,
    source: "not_available",
    attribution: [],
  };
}

function roleLabel(g: ResolvedGrant): string {
  const parts: string[] = [`scope=${g.roleScope}`];
  if (g.grantScope.siteId !== null) parts.push(`site=${g.grantScope.siteId}`);
  if (g.grantScope.clinicId !== null) parts.push(`clinic=${g.grantScope.clinicId}`);
  if (g.grantScope.teamId !== null) parts.push(`team=${g.grantScope.teamId}`);
  return `role(${parts.join(",")})`;
}

/**
 * Convenience helper that re-uses the same source-aware resolver
 * to answer "which permissions are denied to this user here, AND
 * why?". Used by the admin role editor's "denials" tab and by the
 * "request access" workflow.
 */
export async function getDeniedPermissionsWithReason(
  overrideSource?: PermissionOverrideSource
): Promise<
  ReadonlyArray<{
    readonly permission: PermissionCode;
    readonly reason: PermissionSource;
    readonly description: string;
  }>
> {
  const all = await getEffectivePermissionsWithSource(overrideSource);
  return all
    .filter((e) => !e.granted)
    .map((e) => ({
      permission: e.permission,
      reason: e.source,
      description: PERMISSION_METADATA[e.permission].description,
    }));
}
