// Process-level RBAC configuration.
//
// One process, one loader. Set at boot (apps/web, apps/worker,
// migrations, seed). Reading without configuration throws an
// `InternalError(RBAC_NOT_CONFIGURED)` — silence here would be a
// SOC 2 issue (a route handler that quietly skips permission
// checks because the loader wasn't wired).
//
// Why a singleton instead of dependency injection at each call site:
//   - `requirePermission(code)` is called HUNDREDS of times per
//     command handler invocation. Threading a loader through every
//     call would create a code-review noise floor in which the
//     ACTUAL permission requirements get lost.
//   - The loader is a pure infrastructure detail (which database,
//     which connection). Domain code shouldn't care.
//   - Tests configure the loader once per `describe` block; same
//     ergonomics as `vi.mock`.
//
// Re-configuration is allowed (and useful in test setup). It is
// NOT thread-safe for production — but Node is single-threaded and
// production configuration happens before any traffic.

import { runtime } from "@pharmax/platform-core";

import type { EffectivePermissionLoader } from "./loader.js";
import { rbacNotConfiguredError } from "./errors.js";

export interface RbacConfiguration {
  readonly loader: EffectivePermissionLoader;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<RbacConfiguration>("pharmax:rbac:config");

/**
 * Wire the process-wide RBAC loader. Call once at boot.
 */
export function configureRbac(config: RbacConfiguration): void {
  box.value = Object.freeze({ ...config });
}

/**
 * Returns the configured RBAC configuration. Throws
 * `InternalError(RBAC_NOT_CONFIGURED)` if `configureRbac` was
 * never called.
 */
export function getRbacConfiguration(): RbacConfiguration {
  if (box.value === null) {
    throw rbacNotConfiguredError();
  }
  return box.value;
}

/**
 * Test-only: reset the configuration. Production code MUST NOT
 * call this.
 */
export function resetRbacConfigurationForTests(): void {
  box.value = null;
}
