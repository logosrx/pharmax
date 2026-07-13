// Session engine — create, resolve, rotate, revoke.
//
// Design (ADR-0030):
//
//   - Sessions are STATEFUL server-side rows. Resolution reads the row
//     every request, so revocation is IMMEDIATE — set `revokedAt` and
//     the very next resolve fails. This is the capability a stateless
//     JWT cannot provide and the specific gap the eonpro evaluation
//     flagged.
//   - Postgres is the source of truth. A Redis read-through can wrap
//     `resolveSession` at the web-tier bridge (the same `cached()`
//     pattern `operator-identity-cache` already uses), invalidated on
//     revoke — so the hot path is not serialized on the DB while
//     correctness still traces to it.
//   - Resolution runs in a SYSTEM-CONTEXT transaction: the token is
//     tenant-less until we match it to a row, exactly like the Clerk
//     userId lookup in `resolve-tenancy.ts`. The RLS policy's
//     `pharmax.system_context = 'true'` branch permits the cross-tenant
//     read; the query is still narrowed by the unique `tokenHash`.
//   - Two expiries: a SLIDING idle timeout (HIPAA automatic logoff) and
//     an ABSOLUTE cap. Activity writes are throttled so a busy session
//     does not write on every request.

import { prisma, type Prisma, type PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { getAuthConfiguration, type AuthConfiguration } from "../configure.js";
import { hashSessionToken, mintSessionToken } from "./token.js";

// Throttle idle-slide writes: only persist `lastActivityAt` when at
// least this long has elapsed. With a 30-minute idle window, ≤60s of
// staleness is negligible (<4%) and removes a write from every request.
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

const RESOLVE_REASON = "auth:resolve-session";
const REVOKE_REASON = "auth:revoke-session";

export const SESSION_NOT_FOUND = "SESSION_NOT_FOUND" as const;
export const SESSION_REVOKED = "SESSION_REVOKED" as const;
export const SESSION_IDLE_EXPIRED = "SESSION_IDLE_EXPIRED" as const;
export const SESSION_ABSOLUTE_EXPIRED = "SESSION_ABSOLUTE_EXPIRED" as const;

export type SessionFailureReason =
  | typeof SESSION_NOT_FOUND
  | typeof SESSION_REVOKED
  | typeof SESSION_IDLE_EXPIRED
  | typeof SESSION_ABSOLUTE_EXPIRED;

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly mfaSatisfied: boolean;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export type SessionResolution =
  | { readonly ok: true; readonly session: ResolvedSession }
  | { readonly ok: false; readonly reason: SessionFailureReason };

/** Prisma client that owns `$transaction` (defaults to the singleton). */
type TxCapableClient = Pick<PrismaClient, "$transaction">;
/** Any executor exposing the `auth_session` delegate (tx or full client). */
type SessionDelegateClient = Pick<Prisma.TransactionClient, "authSession">;

// ---------------------------------------------------------------------------
// Create — called inside the SignIn command's transaction (already in a
// system-context frame because SignIn is a SystemCommand that resolves
// the org). Returns the RAW token (handed to the cookie ONCE) plus the
// persisted session id.
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  readonly tx: SessionDelegateClient;
  readonly userId: string;
  readonly organizationId: string;
  readonly mfaSatisfied: boolean;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly config?: AuthConfiguration;
}

export interface CreatedSession {
  /** The bearer token. Set as the session cookie value; never stored. */
  readonly rawToken: string;
  readonly sessionId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export async function createSessionInTx(input: CreateSessionInput): Promise<CreatedSession> {
  const config = input.config ?? getAuthConfiguration();
  const now = config.clock.now();
  const rawToken = mintSessionToken(config.session.tokenBytes);
  const idleExpiresAt = new Date(now.getTime() + config.session.idleTtlMs);
  const absoluteExpiresAt = new Date(now.getTime() + config.session.absoluteTtlMs);

  const row = await input.tx.authSession.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      tokenHash: hashSessionToken(rawToken),
      mfaSatisfied: input.mfaSatisfied,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastActivityAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
    },
    select: { id: true },
  });

  return { rawToken, sessionId: row.id, idleExpiresAt, absoluteExpiresAt };
}

// ---------------------------------------------------------------------------
// Resolve — the per-request hot path. Runs its own system-context
// transaction so an expiry auto-revoke write is atomic with the read.
// ---------------------------------------------------------------------------

export interface ResolveSessionInput {
  readonly rawToken: string;
  /** Defaults to the Prisma singleton; injectable for tests. */
  readonly client?: TxCapableClient;
  readonly config?: AuthConfiguration;
}

export async function resolveSession(input: ResolveSessionInput): Promise<SessionResolution> {
  const config = input.config ?? getAuthConfiguration();
  const client = input.client ?? prisma;
  const tokenHash = hashSessionToken(input.rawToken);
  const now = config.clock.now();

  return withSystemContext(RESOLVE_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, RESOLVE_REASON);

      const row = await tx.authSession.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          mfaSatisfied: true,
          lastActivityAt: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          revokedAt: true,
        },
      });

      if (row === null) {
        return { ok: false, reason: SESSION_NOT_FOUND } as const;
      }
      if (row.revokedAt !== null) {
        return { ok: false, reason: SESSION_REVOKED } as const;
      }
      if (row.absoluteExpiresAt.getTime() <= now.getTime()) {
        await tx.authSession.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedReason: "ABSOLUTE_TIMEOUT" },
        });
        return { ok: false, reason: SESSION_ABSOLUTE_EXPIRED } as const;
      }
      if (row.idleExpiresAt.getTime() <= now.getTime()) {
        await tx.authSession.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedReason: "IDLE_TIMEOUT" },
        });
        return { ok: false, reason: SESSION_IDLE_EXPIRED } as const;
      }

      // Valid. Slide the idle window, throttled. The absolute cap still
      // bounds total lifetime regardless of activity.
      let idleExpiresAt = row.idleExpiresAt;
      if (now.getTime() - row.lastActivityAt.getTime() >= ACTIVITY_WRITE_THROTTLE_MS) {
        idleExpiresAt = new Date(now.getTime() + config.session.idleTtlMs);
        await tx.authSession.update({
          where: { id: row.id },
          data: { lastActivityAt: now, idleExpiresAt },
        });
      }

      return {
        ok: true,
        session: {
          sessionId: row.id,
          userId: row.userId,
          organizationId: row.organizationId,
          mfaSatisfied: row.mfaSatisfied,
          idleExpiresAt,
          absoluteExpiresAt: row.absoluteExpiresAt,
        },
      } as const;
    })
  );
}

// ---------------------------------------------------------------------------
// Revoke. `...InTx` variants run inside a command's transaction (audit +
// outbox written by the bus). The by-token variant is for logout when
// only the cookie is known; it opens its own system-context tx.
// ---------------------------------------------------------------------------

export type RevokeReason =
  | "USER_LOGOUT"
  | "ADMIN_REVOKED"
  | "PASSWORD_CHANGED"
  | "MFA_RESET"
  | "ROTATED"
  | "USER_TERMINATED"
  | "SECURITY_EVENT";

/** Revoke a single session by id, within a caller-provided transaction. */
export async function revokeSessionInTx(input: {
  readonly tx: SessionDelegateClient;
  readonly sessionId: string;
  readonly reason: RevokeReason;
  readonly config?: AuthConfiguration;
}): Promise<void> {
  const config = input.config ?? getAuthConfiguration();
  await input.tx.authSession.updateMany({
    where: { id: input.sessionId, revokedAt: null },
    data: { revokedAt: config.clock.now(), revokedReason: input.reason },
  });
}

/**
 * Revoke ALL active sessions for a user (password change, termination,
 * "log out everywhere"). Within a caller-provided transaction.
 */
export async function revokeAllUserSessionsInTx(input: {
  readonly tx: SessionDelegateClient;
  readonly userId: string;
  readonly reason: RevokeReason;
  readonly config?: AuthConfiguration;
}): Promise<number> {
  const config = input.config ?? getAuthConfiguration();
  const result = await input.tx.authSession.updateMany({
    where: { userId: input.userId, revokedAt: null },
    data: { revokedAt: config.clock.now(), revokedReason: input.reason },
  });
  return result.count;
}

/** Revoke by raw token (logout path). Opens its own system-context tx. */
export async function revokeSessionByToken(input: {
  readonly rawToken: string;
  readonly reason: RevokeReason;
  readonly client?: TxCapableClient;
  readonly config?: AuthConfiguration;
}): Promise<void> {
  const config = input.config ?? getAuthConfiguration();
  const client = input.client ?? prisma;
  const tokenHash = hashSessionToken(input.rawToken);
  await withSystemContext(REVOKE_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REVOKE_REASON);
      await tx.authSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: config.clock.now(), revokedReason: input.reason },
      });
    })
  );
}
