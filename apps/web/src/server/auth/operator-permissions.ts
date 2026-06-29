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
  type EffectivePermissionLoader,
  type PermissionCode,
} from "@pharmax/rbac";
import type { TenancyContext } from "@pharmax/tenancy";

import { getServerCache } from "../cache.js";
import { CachedPermissionLoader } from "./operator-permission-cache.js";

let loader: EffectivePermissionLoader | null = null;

function getLoader(): EffectivePermissionLoader {
  // Lazy singleton. The production loader is the `PrismaPermissionLoader`
  // (one four-table join) wrapped in a cross-request `CachedPermissionLoader`
  // so a hot operator's repeated navigations reuse the grants instead of
  // re-running the join. The cache is `getServerCache()` — Redis when
  // REDIS_URL is set, NoopCache otherwise (so this is a no-op without
  // Redis, identical to the uncached behavior). Per-request dedupe still
  // happens one level up in `resolveEffectivePermissions`' WeakMap.
  if (loader === null) {
    loader = new CachedPermissionLoader(new PrismaPermissionLoader(prisma), getServerCache());
  }
  return loader;
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
