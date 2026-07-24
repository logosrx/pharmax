// AsyncLocalStorage-based context propagation.
//
// The choice of ALS over explicit parameter threading is not a style
// preference — it's the only pattern that survives:
//
//   - Promise microtask continuations across the await keyword
//   - setTimeout / setImmediate / Promise.all / dynamic imports
//   - Library callbacks that don't take a "context" param (e.g.
//     Prisma extension hooks, fetch response handlers)
//   - Long-running iteration where threading a param every call would
//     hide the per-iteration scope change
//
// Bypass policy:
//   - `withTenancyContext(ctx, fn)` is the canonical entry. Use at
//     the API/transport boundary (route handler, worker drain
//     hand-off) after authentication resolves the actor.
//   - `withSystemContext(reason, fn)` is the EXPLICIT bypass for
//     supervisor processes (workers draining cross-org outbox,
//     migrations, seed scripts). The `reason` parameter exists so
//     the audit channel can record WHY tenancy was bypassed — every
//     `withSystemContext` call should pair with an audit entry.
//   - "No frame at all" is the developer-mistake mode. The Prisma
//     extension treats it as fail-closed: any tenant-scoped query
//     throws `AuthorizationError(TENANCY_NO_CONTEXT)`.
//
// Why distinguish "no frame" from "system context": if we treated
// missing context as system bypass, every accidentally-unwrapped
// route handler would silently leak across tenants. With this split,
// silence is impossible — the dev sees a 403 in their first test run.

import { AsyncLocalStorage } from "node:async_hooks";

import { errors, runtime } from "@pharmax/platform-core";

import type { TenancyContext } from "./context.js";

type StoredContext =
  | { readonly kind: "user"; readonly ctx: TenancyContext }
  | { readonly kind: "system"; readonly reason: string };

// globalThis-backed (NOT module-scope): Next.js compiles the
// instrumentation hook and each route into separate bundles, each
// with its own copy of this module. The PrismaClient is a globalThis
// singleton shared across those bundles, so the tenancy extension
// bound to it must consult the SAME ALS instance that
// `withTenancyContext` / `withSystemContext` write to — otherwise a
// context entered in a route bundle is invisible to the extension
// created in the instrumentation bundle, and every tenant query
// fails with TENANCY_NO_CONTEXT.
const storage = runtime.globalSingleton(
  "pharmax:tenancy:als",
  () => new AsyncLocalStorage<StoredContext>()
);

/**
 * Run `fn` inside a user-tenancy context. All queries on tenant-
 * scoped models within `fn` (and its async continuations) will be
 * auto-scoped to `ctx.organizationId`.
 *
 * The callback's return value is awaited INSIDE the ALS frame (the
 * async wrapper below), not merely returned through it. This matters
 * for LAZY thenables — Prisma's PrismaPromise defers query execution
 * until `.then()` is called, so a callback like
 * `() => prisma.order.findMany(...)` that returns the bare
 * PrismaPromise without awaiting would otherwise execute the query
 * AFTER the frame exits, and the tenancy extension would see no
 * context (fail-closed TENANCY_NO_CONTEXT on a correctly-wrapped
 * call site). First surfaced by the 2026-Q3 restore drill's verify
 * phase after Prisma 7 + the tenancy-registry classification of
 * `Organization`.
 */
export function withTenancyContext<T>(
  ctx: TenancyContext,
  fn: () => PromiseLike<T> | T
): Promise<T> {
  return storage.run({ kind: "user", ctx }, async () => await fn());
}

/**
 * Run `fn` inside an explicit system context. The Prisma extension
 * will PASS THROUGH all queries unfiltered. Use ONLY for supervisor
 * code (worker drains, migrations, seed). The `reason` is intended
 * to feed an audit_log entry; the caller is responsible for writing
 * that entry — this function only sets the ALS state.
 *
 * TODO Phase 5: gate this behind a `system.bypass_tenancy` permission
 * check resolved from the calling process identity, and auto-write
 * the audit entry from within this wrapper.
 */
export function withSystemContext<T>(reason: string, fn: () => PromiseLike<T> | T): Promise<T> {
  // Await inside the frame — see withTenancyContext for why (lazy
  // thenables like PrismaPromise must begin execution in-frame).
  return storage.run({ kind: "system", reason }, async () => await fn());
}

/**
 * Returns the active user tenancy context, or `null` if either no
 * frame is active OR the active frame is a system context. Use this
 * when you need to know "what org are we in?" without throwing.
 */
export function getCurrentContext(): TenancyContext | null {
  const stored = storage.getStore();
  return stored?.kind === "user" ? stored.ctx : null;
}

/**
 * Returns the active user tenancy context. Throws
 * `AuthorizationError(TENANCY_NO_CONTEXT)` if no user context is
 * active. Use this when the call MUST be tenant-scoped — for
 * example, a domain repository method.
 */
export function requireCurrentContext(): TenancyContext {
  const ctx = getCurrentContext();
  if (ctx === null) {
    throw new errors.AuthorizationError({
      code: "TENANCY_NO_CONTEXT",
      message: "Operation requires a tenancy context but none is active.",
    });
  }
  return ctx;
}

/**
 * True iff the active ALS frame is a `withSystemContext` frame.
 * The Prisma extension consults this to decide whether to pass
 * queries through unscoped.
 */
export function isSystemContext(): boolean {
  return storage.getStore()?.kind === "system";
}

/**
 * Returns the system-context reason string, or `null` if not in a
 * system context. Exposed for the audit/log channel.
 */
export function getSystemContextReason(): string | null {
  const stored = storage.getStore();
  return stored?.kind === "system" ? stored.reason : null;
}

/**
 * Returns `"user"`, `"system"`, or `"none"` for the active frame.
 * Use for diagnostics and logging only; production logic should
 * use the typed accessors above.
 */
export function describeCurrentContext(): "user" | "system" | "none" {
  const stored = storage.getStore();
  if (stored === undefined) return "none";
  return stored.kind;
}
