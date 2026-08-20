// Grant shape + scope matching logic.
//
// A `ResolvedGrant` is the in-memory projection of one row in
// `user_role` joined with the corresponding `role`, `role_permission`,
// and `permission` rows. We collapse multiple role_permission rows
// into a single `ResolvedGrant` per (userRole, role) pair to keep
// the resolver's inner loop tight.
//
// Scope semantics:
//   - `roleScope` defines the FINEST scope the role can be granted
//     at. A `Pharmacist` role with `roleScope = SITE` cannot be
//     granted with a teamId pin (the admin UI should prevent this;
//     the resolver does NOT re-validate — it trusts the database).
//   - Grant scope columns (siteId/clinicId/teamId) define WHERE
//     the grant is active. A null column means "any value of that
//     scope". An ORG-wide admin grant has all three null.
//
// Matching against a TenancyContext:
//   - For each non-null grant scope column, the corresponding
//     context column MUST equal it.
//   - Null grant columns are wildcards.
//   - A grant with ALL-null columns is org-wide; combined with the
//     fact that the tenancy extension already filters every query
//     by organizationId, that means org-wide grants are effectively
//     "anywhere in this org".
//
// Notably: an ORG-wide grant (all-null) IS allowed even when the
// active context has a clinicId or teamId set. The grant doesn't
// CARE about the context's narrowness — only that no non-null grant
// scope contradicts it.

import type { RoleScope } from "@pharmax/database";
import type { TenancyContext } from "@pharmax/tenancy";

import type { PermissionCode } from "./permissions.js";

export interface GrantScope {
  readonly siteId: string | null;
  readonly clinicId: string | null;
  readonly teamId: string | null;
}

export interface ResolvedGrant {
  readonly roleScope: RoleScope;
  readonly grantScope: GrantScope;
  readonly permissions: ReadonlySet<PermissionCode>;
}

/**
 * Returns true iff the grant's scope columns are compatible with
 * the active tenancy context. The grant's `permissions` field is
 * NOT consulted here — call sites check permission membership
 * after filtering by `appliesInContext`.
 */
export function appliesInContext(grant: ResolvedGrant, ctx: TenancyContext): boolean {
  // Sites: if grant pinned to a site, context must be in that site.
  if (grant.grantScope.siteId !== null) {
    if (ctx.siteId !== grant.grantScope.siteId) return false;
  }
  // Clinics: same.
  if (grant.grantScope.clinicId !== null) {
    if (ctx.clinicId !== grant.grantScope.clinicId) return false;
  }
  // Teams: same.
  if (grant.grantScope.teamId !== null) {
    if (ctx.teamId !== grant.grantScope.teamId) return false;
  }
  return true;
}

/**
 * A concrete resource scope to authorize an action against — e.g. the
 * clinic/site a locked order belongs to. Unlike a `TenancyContext`
 * (which describes where the ACTOR is operating), this describes where
 * the RESOURCE lives, and is the axis cross-clinic isolation must be
 * enforced on. `teamId` is optional because most resources (orders) are
 * clinic/site-scoped and carry no team dimension.
 */
export interface ScopeTarget {
  readonly siteId: string | null;
  readonly clinicId: string | null;
  readonly teamId?: string | null;
}

/**
 * Returns true iff the grant's scope pins are all satisfied by the
 * resource's own scope. The mirror of `appliesInContext`, but evaluated
 * against a concrete resource rather than the session context: for each
 * dimension the grant pins (non-null), the resource's value on that
 * dimension MUST equal it; a null pin is a wildcard.
 *
 * Fail-closed on dimensions the resource does not carry: a grant pinned
 * to a team does NOT authorize an action on a clinic/site-scoped order
 * (the order has no team to match), so a purely team-scoped role holds
 * no authority over orders. This is deliberate — the safe direction.
 *
 * This is the authoritative cross-clinic check: a clinic-A-pinned grant
 * `appliesToScope` an order in clinic A and NOT one in clinic B,
 * regardless of what (if anything) the session context declared.
 */
export function appliesToScope(grant: ResolvedGrant, target: ScopeTarget): boolean {
  if (grant.grantScope.siteId !== null) {
    if (target.siteId !== grant.grantScope.siteId) return false;
  }
  if (grant.grantScope.clinicId !== null) {
    if (target.clinicId !== grant.grantScope.clinicId) return false;
  }
  if (grant.grantScope.teamId !== null) {
    if ((target.teamId ?? null) !== grant.grantScope.teamId) return false;
  }
  return true;
}

/**
 * Convenience: flatten a list of applicable grants into a single
 * `Set<PermissionCode>`. Used by the resolver to produce the
 * effective set the guard checks against.
 */
export function unionPermissions(
  grants: ReadonlyArray<ResolvedGrant>
): ReadonlySet<PermissionCode> {
  const out = new Set<PermissionCode>();
  for (const g of grants) {
    for (const p of g.permissions) out.add(p);
  }
  return out;
}
