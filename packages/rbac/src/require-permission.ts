// requirePermission — the primary guard.
//
// Usage:
//
//     import { requirePermission, PERMISSIONS } from "@pharmax/rbac";
//
//     await requirePermission(PERMISSIONS.PV1_APPROVE);
//
// Behavior:
//   1. Pulls the active user tenancy context from `@pharmax/tenancy`.
//      If no user context is active, throws `AuthorizationError(TENANCY_NO_CONTEXT)`
//      (delegated to tenancy — same error a tenant-scoped query would throw).
//   2. Resolves the actor's effective permissions for this context
//      (cached per-context via WeakMap; first call hits the loader,
//      subsequent calls in the same request are free).
//   3. If the requested permission is in the effective set, returns.
//   4. Otherwise throws `AuthorizationError(PERMISSION_DENIED)`.
//
// What this DOES NOT do:
//   - Write to audit_log. That is the command bus's job. RBAC throws;
//     the bus catches and writes an audit entry with the denial.
//   - Handle "system actor" callers. `withSystemContext` bypasses
//     the tenancy frame, which means `requirePermission` will throw
//     TENANCY_NO_CONTEXT inside a system context. That is correct:
//     system code shouldn't be making permission checks against
//     users it doesn't represent.
//   - Support "any of N permissions" or "all of N permissions"
//     composite checks. If a flow needs that, build it from
//     two `requirePermission` calls (for AND) or a custom helper
//     calling `getEffectivePermissions` directly (for OR). The
//     primary guard stays single-purpose for code-review clarity.

import { tenancy } from "@pharmax/tenancy";

import { getRbacConfiguration } from "./configure.js";
import { PERMISSION_DENIED, permissionDeniedError, permissionUnknownError } from "./errors.js";
import { ALL_PERMISSION_CODES, type PermissionCode } from "./permissions.js";
import { resolveEffectivePermissions } from "./resolver.js";

/**
 * Throws if the active actor does not have the given permission
 * in the current tenancy context.
 */
export async function requirePermission(permission: PermissionCode): Promise<void> {
  if (!(ALL_PERMISSION_CODES as ReadonlyArray<string>).includes(permission)) {
    throw permissionUnknownError({ attempted: permission });
  }

  const ctx = tenancy.requireCurrentContext();
  const config = getRbacConfiguration();
  const effective = await resolveEffectivePermissions(ctx, config.loader);

  if (!effective.has(permission)) {
    throw permissionDeniedError({
      permission,
      organizationId: ctx.organizationId,
      userId: ctx.actor.userId,
      correlationId: ctx.actor.correlationId,
    });
  }
}

/**
 * Non-throwing query: returns true iff the active actor has the
 * given permission in the current tenancy context. Use for UI
 * affordance toggles ("show the Approve button?"). NEVER use as
 * a security check — only `requirePermission` is the auth gate.
 */
export async function hasPermission(permission: PermissionCode): Promise<boolean> {
  if (!(ALL_PERMISSION_CODES as ReadonlyArray<string>).includes(permission)) {
    return false;
  }
  const ctx = tenancy.requireCurrentContext();
  const config = getRbacConfiguration();
  const effective = await resolveEffectivePermissions(ctx, config.loader);
  return effective.has(permission);
}

/**
 * Returns the FULL effective permission set for the active actor +
 * context. Use sparingly — `requirePermission` should be the
 * default. Exposed for admin endpoints that surface "what can this
 * user do here?" UIs, and for composite checks.
 */
export async function getEffectivePermissions(): Promise<ReadonlySet<PermissionCode>> {
  const ctx = tenancy.requireCurrentContext();
  const config = getRbacConfiguration();
  return resolveEffectivePermissions(ctx, config.loader);
}

// Re-export the denial code so callers can match on it without
// importing the errors barrel.
export { PERMISSION_DENIED };
