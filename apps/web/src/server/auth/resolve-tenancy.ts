// Server-side bridge: Clerk session → Pharmax `TenancyContext`.
//
// The web tier's API routes + server components use this helper as
// the single entry point for "who is this operator, and what
// tenancy do they belong to?". The output is the standard
// `TenancyContext` that every command in the existing bus already
// understands — meaning the entire operator console can dispatch
// commands without inventing a new auth surface.
//
// Flow:
//
//   1. `auth()` returns the Clerk session (`{ userId: clerkUserId }`).
//      No session ⇒ caller hands back 401 / redirect (the `proxy.ts`
//      middleware should have already gated unauthenticated traffic
//      out — this is a second line of defense).
//
//   2. System-context lookup of the Pharmax `user` row by
//      `clerkUserId`. The `(clerkUserId)` partial-unique index
//      makes this O(1).
//
//   3. The user row's `organizationId` becomes the tenant scope.
//      Operators belong to exactly one organization in v1; future
//      multi-org operators would either get distinct Clerk
//      identities per org, OR use Clerk Organizations + a different
//      resolver shape. v1 keeps it deliberately simple.
//
//   4. Return a `TenancyContext` with a fresh `correlationId` per
//      request (ulid). The command bus uses it to thread the
//      operator's action through `command_log` / `audit_log`.
//
// Failure modes (all return `null` so callers render a 401 / sign-out
// flow rather than crashing):
//
//   - No Clerk session.
//   - Clerk session present but no Pharmax user row links to it.
//     (Operator was sign-in'd but never provisioned. Operator UI
//     should render "contact your admin to provision your account".)
//
//   - Pharmax user is not ACTIVE. INVITED / DISABLED / TERMINATED
//     users should not be able to dispatch commands; surface as a
//     distinct error so the UI can render the right message.
//
// PHI invariant: no PHI is read. The user row is non-PHI by
// definition (email + displayName are operator identifiers, not
// patient data).

import "server-only";

import { cache } from "react";

import { auth } from "@clerk/nextjs/server";
import { cached, type Cache } from "@pharmax/composition";
import { prisma, UserStatus, type PrismaClient } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";
import {
  applySystemSessionGuc,
  buildTenancyContext,
  withSystemContext,
  type SessionGucExecutor,
  type TenancyContext,
} from "@pharmax/tenancy";

import { getServerCache } from "../cache.js";
import { logger } from "../logger.js";
import {
  operatorIdentityCacheKey,
  OPERATOR_IDENTITY_CACHE_TTL_MS,
  type CachedOperatorRow,
} from "./operator-identity-cache.js";

export const RESOLVE_TENANCY_NO_SESSION = "RESOLVE_TENANCY_NO_SESSION";
export const RESOLVE_TENANCY_USER_NOT_LINKED = "RESOLVE_TENANCY_USER_NOT_LINKED";
export const RESOLVE_TENANCY_USER_NOT_ACTIVE = "RESOLVE_TENANCY_USER_NOT_ACTIVE";

export type ResolveTenancyFailure =
  | typeof RESOLVE_TENANCY_NO_SESSION
  | typeof RESOLVE_TENANCY_USER_NOT_LINKED
  | typeof RESOLVE_TENANCY_USER_NOT_ACTIVE;

export type ResolveTenancyResult =
  | {
      readonly ok: true;
      readonly tenancy: TenancyContext;
      readonly operator: {
        readonly userId: string;
        readonly organizationId: string;
        readonly email: string;
        readonly displayName: string;
        readonly clerkUserId: string;
      };
    }
  | {
      readonly ok: false;
      readonly reason: ResolveTenancyFailure;
      /** Present when the Clerk session resolves but the Pharmax link fails. */
      readonly clerkUserId?: string;
    };

interface ResolveTenancyOptions {
  /**
   * Injectable for tests. Defaults to the real Clerk `auth()` and the
   * real Pharmax Prisma client.
   */
  readonly auth?: () => Promise<{ userId: string | null }>;
  /**
   * Injectable for tests. Needs `$transaction` (the lookup runs in a
   * system-GUC transaction so it is permitted under the RLS-subject
   * `pharmax_app` role) and the `user` delegate.
   */
  readonly client?: Pick<PrismaClient, "$transaction" | "user">;
  /**
   * Injectable for tests. The cross-request cache for the Clerk userId →
   * Pharmax `user` row mapping. Defaults to the process cache singleton
   * (RedisCache when REDIS_URL is set, NoopCache otherwise).
   */
  readonly cache?: Cache;
}

async function resolveOperatorTenancyContextImpl(
  options: ResolveTenancyOptions = {}
): Promise<ResolveTenancyResult> {
  const authFn = options.auth ?? (auth as unknown as () => Promise<{ userId: string | null }>);
  const client = options.client ?? prisma;

  const session = await authFn();
  const clerkUserId = session.userId;
  if (clerkUserId === null) {
    return Object.freeze({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
  }

  // The webhook drain pattern uses system context to read across
  // tenants when an external identifier is the only signal. Same
  // shape here: a Clerk user id is tenant-less until we resolve
  // it to the Pharmax user row.
  //
  // Note on auto-linking: the link from Clerk identity → Pharmax
  // user row is established asynchronously by the `user.created`
  // Clerk webhook handler (`clerk-webhook-handlers.ts`). If the
  // operator's first request beats the webhook delivery, they'll
  // see USER_NOT_LINKED briefly and the next refresh succeeds.
  // We deliberately do NOT pull-fallback here to keep this hot
  // path off the Clerk API.
  const reason = "apps/web:resolve-operator-tenancy";
  const cacheInstance = options.cache ?? getServerCache();

  // Cross-request read-through. `cached()` returns a hit when present,
  // otherwise runs the authoritative system-context lookup and caches the
  // row for OPERATOR_IDENTITY_CACHE_TTL_MS. A null (not-linked) result is
  // never cached, so a just-provisioned operator is never locked out; the
  // Clerk webhooks invalidate this key on every identity mutation.
  const user = await cached<CachedOperatorRow | null>({
    cache: cacheInstance,
    key: operatorIdentityCacheKey(clerkUserId),
    ttlMs: OPERATOR_IDENTITY_CACHE_TTL_MS,
    load: () =>
      withSystemContext(reason, () =>
        client.$transaction(async (tx) => {
          // Set `pharmax.system_context='on'` so the cross-tenant user
          // lookup is permitted under the non-BYPASSRLS `pharmax_app`
          // role. The query is still narrowed by the unique `clerkUserId`.
          await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
          return tx.user.findUnique({
            where: { clerkUserId },
            select: {
              id: true,
              organizationId: true,
              email: true,
              displayName: true,
              status: true,
              clerkUserId: true,
            },
          });
        })
      ),
    onError: (stage, error) => {
      // Cache transport failure is non-fatal — `cached()` already fell
      // through to the loader. Log for metrics only.
      logger.warn("auth.operator_identity_cache.error", {
        stage,
        errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      });
    },
  });

  if (user === null) {
    return Object.freeze({
      ok: false,
      reason: RESOLVE_TENANCY_USER_NOT_LINKED,
      clerkUserId,
    });
  }
  if (user.status !== UserStatus.ACTIVE) {
    return Object.freeze({
      ok: false,
      reason: RESOLVE_TENANCY_USER_NOT_ACTIVE,
      clerkUserId,
    });
  }

  const tenancy = buildTenancyContext({
    organizationId: user.organizationId,
    actor: { userId: user.id, correlationId: ids.generateUlid() },
  });

  return Object.freeze({
    ok: true,
    tenancy,
    operator: {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      displayName: user.displayName,
      // `clerkUserId` is non-null here because the lookup matched.
      clerkUserId: user.clerkUserId!,
    },
  });
}

// ---------------------------------------------------------------------------
// Per-request memoization (production hot path).
//
// A single React server request renders the `/ops/*` layout AND the
// nested page AND (for actions) a route handler — each historically
// called `resolveOperatorTenancyContext()` independently, paying a
// fresh Clerk `auth()` plus a system-context user-lookup transaction
// EVERY time. At enterprise traffic that is the dominant per-navigation
// cost and it also defeated the RBAC permission cache: every call built
// a NEW `TenancyContext`, and `resolveEffectivePermissions` keys its
// memo on the context object, so the permission join re-ran per call.
//
// `cache()` from React is request-scoped on the server: Next allocates
// a fresh cache per RSC request, so there is NO cross-request leakage
// (the same guarantee `cachedClerkMfaLookup` in require-mfa.ts relies
// on). Memoizing the zero-arg path means the layout, the page, and any
// nested reads share ONE auth() + ONE user-lookup tx AND ONE stable
// `TenancyContext` — which in turn makes the permission WeakMap hit, so
// the 4-table permission join also runs once per request.
//
// The injectable `options` path (unit tests, or any caller supplying a
// custom auth()/client) deliberately BYPASSES the cache so each call
// exercises the real resolution with its own dependencies and a fresh
// correlation id.
// ---------------------------------------------------------------------------

const cachedResolveOperatorTenancyContext = cache(
  (): Promise<ResolveTenancyResult> => resolveOperatorTenancyContextImpl()
);

/**
 * Resolve the Clerk session → Pharmax `TenancyContext`.
 *
 * Production callers invoke this with no arguments and get a
 * per-request-memoized result (shared across the layout, the page, and
 * any nested server reads in the same request). Callers that inject
 * `auth` / `client` / `cache` (tests) bypass the memo and run the
 * resolution directly so each call is independent.
 */
export function resolveOperatorTenancyContext(
  options: ResolveTenancyOptions = {}
): Promise<ResolveTenancyResult> {
  if (options.auth !== undefined || options.client !== undefined || options.cache !== undefined) {
    return resolveOperatorTenancyContextImpl(options);
  }
  return cachedResolveOperatorTenancyContext();
}
