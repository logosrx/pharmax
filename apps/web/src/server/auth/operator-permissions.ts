// Operator permission helpers for server components + route handlers.
//
// `resolveEffectivePermissions(tenancy, loader)` (from `@pharmax/rbac`)
// reads the operator's user_role + role_permission rows for the
// current tenancy and returns a `Set<PermissionCode>`. This file is
// the apps/web facade — it wires the production `PrismaPermissionLoader`
// and exposes ergonomic helpers.
//
// Why a thin helper:
//
//   - Server components shouldn't `import` from `@pharmax/rbac`
//     directly because the loader needs the Pharmax PrismaClient,
//     which is wired at bootstrap time. The helper centralizes
//     that wiring.
//
//   - `hasOperatorPermission(set, code)` is just `set.has(code)`,
//     but a named helper improves call-site readability AND lets
//     us add audit-on-deny logging in a single place later.
//
// PHI: no PHI is read. Permission codes + role grants are
// non-PHI by definition.

import "server-only";

import { prisma } from "@pharmax/database";
import {
  PrismaPermissionLoader,
  resolveEffectivePermissions,
  type PermissionCode,
} from "@pharmax/rbac";
import type { TenancyContext } from "@pharmax/tenancy";

let cachedLoader: PrismaPermissionLoader | null = null;

function getLoader(): PrismaPermissionLoader {
  // Lazy singleton — the constructor allocates per-org caches that
  // benefit from being shared across requests in the same process.
  if (cachedLoader === null) {
    cachedLoader = new PrismaPermissionLoader(prisma);
  }
  return cachedLoader;
}

/**
 * Resolve the operator's effective permission set for the given
 * tenancy. The underlying `resolveEffectivePermissions` is itself
 * memoized per `(tenancy.organizationId, tenancy.actor.userId)`
 * so back-to-back calls in the same request are cheap.
 */
export async function loadOperatorPermissions(
  tenancy: TenancyContext
): Promise<ReadonlySet<PermissionCode>> {
  return await resolveEffectivePermissions(tenancy, getLoader());
}

/**
 * Boolean check. Sugar over `set.has(code)` so the call site reads
 * `hasOperatorPermission(perms, PERMISSIONS.SHIP_RESOLVE_ESCALATION)`
 * instead of `perms.has(PERMISSIONS.SHIP_RESOLVE_ESCALATION)`. The
 * named call also gives us a future seam for audit-on-deny logging.
 */
export function hasOperatorPermission(
  permissions: ReadonlySet<PermissionCode>,
  code: PermissionCode
): boolean {
  return permissions.has(code);
}
