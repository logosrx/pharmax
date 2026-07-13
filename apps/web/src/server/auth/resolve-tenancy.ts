// Server-side bridge: Pharmax session → `TenancyContext` (ADR-0030).
//
// The single entry point for "who is this operator, and what tenancy do
// they belong to?". The output is the standard `TenancyContext` every
// command on the bus already understands — so the operator console
// dispatches commands unchanged. This replaced the Clerk bridge; the
// only thing that changed is the SOURCE of identity (our opaque session
// cookie instead of a Clerk JWT), not the downstream contract.
//
// Flow:
//   1. Read the opaque session token from the cookie. Absent ⇒
//      NO_SESSION (caller redirects to /sign-in).
//   2. `resolveSession()` validates it against the DB (revoked? idle?
//      absolute-expired?) and returns { userId, organizationId,
//      mfaSatisfied, sessionId }. Any failure ⇒ NO_SESSION.
//   3. Cross-request-cached lookup of the `user` row by id for
//      email/displayName/status (the near-immutable projection).
//   4. Status gate + build the `TenancyContext` with a fresh
//      correlationId per request.
//
// PHI invariant: no PHI is read. The user row is operator identity.

import "server-only";

import { cache } from "react";

import { resolveSession } from "@pharmax/auth";
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
import { readSessionTokenFromCookies } from "./session-cookie.js";

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
        /** Whether this session has cleared its MFA step-up. */
        readonly mfaSatisfied: boolean;
        /** The active session id (for "revoke others but this one"). */
        readonly sessionId: string;
      };
    }
  | {
      readonly ok: false;
      readonly reason: ResolveTenancyFailure;
    };

interface ResolveTenancyOptions {
  /** Injectable for tests. Defaults to reading the session cookie. */
  readonly rawToken?: string;
  /** Injectable for tests (needs `$transaction` + `user`). */
  readonly client?: Pick<PrismaClient, "$transaction" | "user">;
  /** Injectable for tests. Defaults to the process cache singleton. */
  readonly cache?: Cache;
}

async function resolveOperatorTenancyContextImpl(
  options: ResolveTenancyOptions = {}
): Promise<ResolveTenancyResult> {
  const client = options.client ?? prisma;

  const rawToken = options.rawToken ?? (await readSessionTokenFromCookies());
  if (rawToken === null || rawToken.length === 0) {
    return Object.freeze({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
  }

  const resolved = await resolveSession({
    rawToken,
    ...(options.client !== undefined
      ? { client: options.client as Pick<PrismaClient, "$transaction"> }
      : {}),
  });
  if (!resolved.ok) {
    // Not-found / revoked / idle / absolute-expired all present to the
    // UI as "sign in again".
    return Object.freeze({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
  }

  const { userId, organizationId, mfaSatisfied, sessionId } = resolved.session;
  const reason = "apps/web:resolve-operator-tenancy";
  const cacheInstance = options.cache ?? getServerCache();

  // Cross-request read-through of the near-immutable user projection.
  // A null (missing) result is never cached.
  const user = await cached<CachedOperatorRow | null>({
    cache: cacheInstance,
    key: operatorIdentityCacheKey(userId),
    ttlMs: OPERATOR_IDENTITY_CACHE_TTL_MS,
    load: () =>
      withSystemContext(reason, () =>
        client.$transaction(async (tx) => {
          await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
          return tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              organizationId: true,
              email: true,
              displayName: true,
              status: true,
            },
          });
        })
      ),
    onError: (stage, error) => {
      logger.warn("auth.operator_identity_cache.error", {
        stage,
        errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      });
    },
  });

  if (user === null) {
    return Object.freeze({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_LINKED });
  }
  if (user.status !== UserStatus.ACTIVE) {
    return Object.freeze({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_ACTIVE });
  }

  const tenancy = buildTenancyContext({
    organizationId,
    actor: { userId, correlationId: ids.generateUlid() },
  });

  return Object.freeze({
    ok: true,
    tenancy,
    operator: {
      userId,
      organizationId,
      email: user.email,
      displayName: user.displayName,
      mfaSatisfied,
      sessionId,
    },
  });
}

// Per-request memoization (production hot path): the layout, the page,
// and any nested server reads in one RSC request share ONE session
// resolution + ONE user lookup + ONE stable TenancyContext (which keeps
// the RBAC permission WeakMap warm). React `cache()` is request-scoped
// on the server, so there is no cross-request leakage. The injectable
// path (tests) bypasses the memo.
const cachedResolveOperatorTenancyContext = cache(
  (): Promise<ResolveTenancyResult> => resolveOperatorTenancyContextImpl()
);

export function resolveOperatorTenancyContext(
  options: ResolveTenancyOptions = {}
): Promise<ResolveTenancyResult> {
  if (
    options.rawToken !== undefined ||
    options.client !== undefined ||
    options.cache !== undefined
  ) {
    return resolveOperatorTenancyContextImpl(options);
  }
  return cachedResolveOperatorTenancyContext();
}
