// RBAC error codes.
//
// All denial errors are `AuthorizationError` (HTTP 403, category
// "expected") so the bus does NOT page on them — they represent
// a routine "you can't do that" surfaced to the UI and to the
// SOC 2 audit feed.
//
// PHI rule: NOTHING in error metadata can be patient data. The
// guard sits below the command handler and doesn't know about
// orders/patients. The most identifying field we expose is
// `actor.userId` (a staff member id) and `actor.correlationId`
// (an opaque ULID).

import { errors } from "@pharmax/platform-core";

import type { PermissionCode } from "./permissions.js";

/** Actor is missing the permission required for this action. */
export const PERMISSION_DENIED = "PERMISSION_DENIED" as const;

/**
 * A caller asked for a permission code not in the registry. This
 * is a developer mistake (typo, stale string) — we surface it as
 * a 500-class InternalError so it's loud in tests.
 */
export const PERMISSION_UNKNOWN = "PERMISSION_UNKNOWN" as const;

/**
 * `configureRbac` was never called for this process, so the guard
 * has no loader to query. InternalError because it's a boot bug,
 * not a user mistake.
 */
export const RBAC_NOT_CONFIGURED = "RBAC_NOT_CONFIGURED" as const;

export function permissionDeniedError(detail: {
  readonly permission: PermissionCode;
  readonly organizationId: string;
  readonly userId: string;
  readonly correlationId: string;
}): errors.AuthorizationError {
  return new errors.AuthorizationError({
    code: PERMISSION_DENIED,
    message: "Permission denied.",
    metadata: {
      permission: detail.permission,
      organizationId: detail.organizationId,
      userId: detail.userId,
      correlationId: detail.correlationId,
    },
  });
}

export function permissionUnknownError(detail: {
  readonly attempted: string;
}): errors.InternalError {
  return new errors.InternalError({
    code: PERMISSION_UNKNOWN,
    message: `Unknown permission code "${detail.attempted}" — not in the registry.`,
    metadata: { attempted: detail.attempted },
  });
}

export function rbacNotConfiguredError(): errors.InternalError {
  return new errors.InternalError({
    code: RBAC_NOT_CONFIGURED,
    message:
      "@pharmax/rbac was not configured. Call configureRbac({ loader }) at process boot before any requirePermission call.",
  });
}
