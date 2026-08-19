// URL helpers for pinning a Postgres session role. Side-effect free.
//
// Extracted from `setup-env.ts` so other modules can import the helper
// WITHOUT executing that file's module scope. `setup-env.ts` mutates
// `process.env` on import; when `system-prisma.ts` imported it for this
// function, vitest instantiated it a second time (the setupFiles copy
// and the imported copy are separate module instances), and the re-run
// resolved its "base" URL from the by-then-pinned DATABASE_URL —
// silently turning the owner URL into an app-role URL and the system
// client into an app client. Keeping the helper in a module with no
// side effects makes that failure unrepresentable.

/**
 * Return `url` with the libpq `options` startup parameter set to pin the
 * session role, preserving anything already in the query string.
 *
 * If the caller already pinned a role — a CI job or a developer testing
 * the `pharmax_system` path — that choice is respected rather than
 * overwritten. Silently replacing an explicit role would make this file
 * the reason a deliberate experiment produced confusing results.
 */
export function pinSessionRole(url: string, role: string): string {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("options");
  if (existing !== null && existing.includes("role=")) {
    return url;
  }
  parsed.searchParams.set("options", `-c role=${role}`);
  return parsed.toString();
}
