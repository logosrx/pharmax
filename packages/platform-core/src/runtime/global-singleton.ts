// globalSingleton — process-wide singleton storage that survives
// bundler module duplication.
//
// Why this exists: Next.js (webpack) compiles the instrumentation
// hook and each route into SEPARATE bundles. A workspace package
// imported from both is instantiated once PER BUNDLE, so module-scope
// state (`let configured = ...`, an `AsyncLocalStorage` instance) is
// NOT shared between "boot" (instrumentation) and "serve" (route
// handlers). The observable failure: bootstrap() wires crypto / RBAC /
// command-bus / tenancy in the instrumentation bundle, and the first
// route render throws CRYPTO_NOT_CONFIGURED or TENANCY_NO_CONTEXT
// from the route bundle's pristine copy.
//
// `globalThis` is the one object every bundle in a Node process
// shares (the Prisma client in @pharmax/database/client.ts already
// relies on this). Any state that is semantically "one per process"
// MUST live behind this helper rather than at module scope.
//
// Keys are namespaced strings ("pharmax:<package>:<thing>") rather
// than Symbols: a Symbol created per-module-copy would defeat the
// purpose, and Symbol.for() is just a string registry with extra
// steps.
//
// Dev-HMR bonus: state also survives hot-module replacement, which
// re-evaluates module scope but keeps globalThis.

type GlobalSingletonHost = typeof globalThis & {
  __pharmaxSingletons?: Map<string, unknown>;
};

/**
 * Returns the value stored under `key`, creating it with `factory`
 * on first access. The same key always yields the same instance for
 * the lifetime of the process, regardless of how many bundle copies
 * of the calling module exist.
 */
export function globalSingleton<T>(key: string, factory: () => T): T {
  const host = globalThis as GlobalSingletonHost;
  host.__pharmaxSingletons ??= new Map<string, unknown>();
  if (!host.__pharmaxSingletons.has(key)) {
    host.__pharmaxSingletons.set(key, factory());
  }
  return host.__pharmaxSingletons.get(key) as T;
}

/**
 * A mutable box for configure-style singletons (`configureX()` at
 * boot, `getXConfiguration()` at use). The BOX is the process-wide
 * singleton; its `value` stays reassignable so configure / reset
 * semantics are unchanged.
 */
export interface SingletonBox<T> {
  value: T | null;
}

export function globalSingletonBox<T>(key: string): SingletonBox<T> {
  return globalSingleton<SingletonBox<T>>(key, () => ({ value: null }));
}
