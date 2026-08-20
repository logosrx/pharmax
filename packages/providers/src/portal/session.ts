// Portal session engine — create, resolve, revoke (ADR-0033,
// slice 2). The PortalAccount twin of `@pharmax/auth`'s session
// service, with identical semantics:
//
//   - STATEFUL server-side rows: revocation is immediate.
//   - Opaque tokens, SHA-256-hashed at rest (reusing the auth
//     package's token primitives), so a DB read yields no usable
//     bearer tokens.
//   - Sliding idle timeout + absolute cap, from the SAME
//     `SessionPolicy` the operator engine uses (HIPAA automatic
//     logoff applies to external principals too).
//   - Resolution runs in a SYSTEM-CONTEXT transaction (tenant-less
//     until the token matches a row), and the organization it hands
//     back is proven against the account's rather than read off the
//     session row alone.
//
// A separate table + service (not a discriminator on auth_session):
// a portal token can never resolve an operator session and vice
// versa — the isolation is structural, not conditional.

import { getAuthConfiguration, hashSessionToken, mintSessionToken } from "@pharmax/auth";
import type { AuthConfiguration } from "@pharmax/auth";
import {
  ClinicProviderAffiliationStatus,
  ClinicStatus,
  PortalAccountStatus,
  prisma,
  type Prisma,
  type PrismaClient,
} from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

// Same activity-write throttle as the operator engine.
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

const RESOLVE_REASON = "portal:resolve-session";
const REVOKE_REASON = "portal:revoke-session";

export const PORTAL_SESSION_NOT_FOUND = "PORTAL_SESSION_NOT_FOUND" as const;
export const PORTAL_SESSION_REVOKED = "PORTAL_SESSION_REVOKED" as const;
export const PORTAL_SESSION_IDLE_EXPIRED = "PORTAL_SESSION_IDLE_EXPIRED" as const;
export const PORTAL_SESSION_ABSOLUTE_EXPIRED = "PORTAL_SESSION_ABSOLUTE_EXPIRED" as const;
export const PORTAL_SESSION_ACCOUNT_DISABLED = "PORTAL_SESSION_ACCOUNT_DISABLED" as const;
/**
 * The session's client was deactivated, or the prescriber's affiliation
 * with it ended, since the session was minted.
 */
export const PORTAL_SESSION_CLIENT_ACCESS_REVOKED = "PORTAL_SESSION_CLIENT_ACCESS_REVOKED" as const;

export type PortalSessionFailureReason =
  | typeof PORTAL_SESSION_NOT_FOUND
  | typeof PORTAL_SESSION_REVOKED
  | typeof PORTAL_SESSION_IDLE_EXPIRED
  | typeof PORTAL_SESSION_ABSOLUTE_EXPIRED
  | typeof PORTAL_SESSION_ACCOUNT_DISABLED
  | typeof PORTAL_SESSION_CLIENT_ACCESS_REVOKED;

export interface ResolvedPortalSession {
  readonly sessionId: string;
  readonly portalAccountId: string;
  readonly providerId: string;
  readonly organizationId: string;
  /**
   * The client practice this session is acting for, and the ONLY
   * trustworthy source of that scope — a clinic id in a request body is
   * caller-controlled. `null` means the prescriber authenticated but
   * has not yet chosen among several affiliations; callers must send
   * them to the chooser rather than reading data unscoped.
   */
  readonly activeClinicId: string | null;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export type PortalSessionResolution =
  | { readonly ok: true; readonly session: ResolvedPortalSession }
  | { readonly ok: false; readonly reason: PortalSessionFailureReason };

type TxCapableClient = Pick<PrismaClient, "$transaction">;
type PortalSessionDelegateClient = Pick<Prisma.TransactionClient, "portalSession">;

// ---------------------------------------------------------------------------
// Create — called inside the PortalSignIn command's transaction.
// ---------------------------------------------------------------------------

export interface CreatePortalSessionInput {
  readonly tx: PortalSessionDelegateClient;
  readonly portalAccountId: string;
  readonly organizationId: string;
  /**
   * Client practice this session acts for. REQUIRED rather than
   * defaulted so every call site has to decide: a prescriber with one
   * affiliation is minted already scoped, and only the
   * multiple-affiliation chooser path passes `null`. An optional
   * parameter would let a new caller create an unscoped session by
   * forgetting about clients entirely.
   */
  readonly activeClinicId: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly config?: AuthConfiguration;
}

export interface CreatedPortalSession {
  /** The bearer token. Set as the portal cookie value; never stored. */
  readonly rawToken: string;
  readonly sessionId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export async function createPortalSessionInTx(
  input: CreatePortalSessionInput
): Promise<CreatedPortalSession> {
  const config = input.config ?? getAuthConfiguration();
  const now = config.clock.now();
  const rawToken = mintSessionToken(config.session.tokenBytes);
  const idleExpiresAt = new Date(now.getTime() + config.session.idleTtlMs);
  const absoluteExpiresAt = new Date(now.getTime() + config.session.absoluteTtlMs);

  const row = await input.tx.portalSession.create({
    data: {
      organizationId: input.organizationId,
      portalAccountId: input.portalAccountId,
      activeClinicId: input.activeClinicId,
      tokenHash: hashSessionToken(rawToken),
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
// Resolve — the per-request hot path for /portal surfaces.
// ---------------------------------------------------------------------------

export interface ResolvePortalSessionInput {
  readonly rawToken: string;
  /** Defaults to the Prisma singleton; injectable for tests. */
  readonly client?: TxCapableClient;
  readonly config?: AuthConfiguration;
}

export async function resolvePortalSession(
  input: ResolvePortalSessionInput
): Promise<PortalSessionResolution> {
  const config = input.config ?? getAuthConfiguration();
  const client = input.client ?? prisma;
  const tokenHash = hashSessionToken(input.rawToken);
  const now = config.clock.now();

  return withSystemContext(RESOLVE_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, RESOLVE_REASON);

      const row = await tx.portalSession.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          portalAccountId: true,
          organizationId: true,
          activeClinicId: true,
          lastActivityAt: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          revokedAt: true,
          portalAccount: { select: { status: true, providerId: true, organizationId: true } },
          activeClinic: { select: { id: true, status: true } },
        },
      });

      if (row === null) {
        return { ok: false, reason: PORTAL_SESSION_NOT_FOUND } as const;
      }
      // The session row's organization is what callers use as the
      // tenancy scope for every portal read and write, so it is not
      // taken on trust: a row whose `organizationId` did not match its
      // account's would scope one tenant's request to another. Same
      // opaque refusal as an unknown token, and no write — a row whose
      // tenancy cannot be proven is not one to file bookkeeping against.
      if (row.portalAccount.organizationId !== row.organizationId) {
        return { ok: false, reason: PORTAL_SESSION_NOT_FOUND } as const;
      }
      if (row.revokedAt !== null) {
        return { ok: false, reason: PORTAL_SESSION_REVOKED } as const;
      }
      // A disabled account invalidates every outstanding session
      // immediately — checked per request, exactly the property a
      // stateless token could not give us.
      if (row.portalAccount.status !== PortalAccountStatus.ACTIVE) {
        await tx.portalSession.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedReason: "USER_TERMINATED" },
        });
        return { ok: false, reason: PORTAL_SESSION_ACCOUNT_DISABLED } as const;
      }
      if (row.absoluteExpiresAt.getTime() <= now.getTime()) {
        await tx.portalSession.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedReason: "ABSOLUTE_TIMEOUT" },
        });
        return { ok: false, reason: PORTAL_SESSION_ABSOLUTE_EXPIRED } as const;
      }
      if (row.idleExpiresAt.getTime() <= now.getTime()) {
        await tx.portalSession.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedReason: "IDLE_TIMEOUT" },
        });
        return { ok: false, reason: PORTAL_SESSION_IDLE_EXPIRED } as const;
      }

      // Client access, re-proven per request rather than trusted from
      // mint time. SetClinicStatus and EndProviderClinicAffiliation
      // both revoke affected sessions, so in the normal case this
      // never fires — which is the point. It makes those revocation
      // sweeps an optimization rather than the only thing standing
      // between a withdrawn affiliation and a live scope, exactly as
      // the account-status check above does for a disabled account.
      if (row.activeClinicId !== null) {
        // `?? null` rather than a bare `!== null` comparison: a relation
        // that was not selected reads as `undefined`, and the failure
        // direction matters here. Coercing first means an unexpected
        // shape refuses the session instead of throwing past the check.
        const activeClinic = row.activeClinic ?? null;
        const clientStillOpen =
          activeClinic !== null && activeClinic.status === ClinicStatus.ACTIVE;
        const affiliation = clientStillOpen
          ? await tx.clinicProviderAffiliation.findFirst({
              where: {
                organizationId: row.organizationId,
                clinicId: row.activeClinicId,
                providerId: row.portalAccount.providerId,
                status: ClinicProviderAffiliationStatus.ACTIVE,
              },
              select: { id: true },
            })
          : null;
        if (!clientStillOpen || affiliation === null) {
          await tx.portalSession.update({
            where: { id: row.id },
            data: { revokedAt: now, revokedReason: "ADMIN_REVOKED" },
          });
          return { ok: false, reason: PORTAL_SESSION_CLIENT_ACCESS_REVOKED } as const;
        }
      }

      // Valid. Slide the idle window, throttled.
      let idleExpiresAt = row.idleExpiresAt;
      if (now.getTime() - row.lastActivityAt.getTime() >= ACTIVITY_WRITE_THROTTLE_MS) {
        idleExpiresAt = new Date(now.getTime() + config.session.idleTtlMs);
        await tx.portalSession.update({
          where: { id: row.id },
          data: { lastActivityAt: now, idleExpiresAt },
        });
      }

      return {
        ok: true,
        session: {
          sessionId: row.id,
          portalAccountId: row.portalAccountId,
          providerId: row.portalAccount.providerId,
          organizationId: row.organizationId,
          activeClinicId: row.activeClinicId,
          idleExpiresAt,
          absoluteExpiresAt: row.absoluteExpiresAt,
        },
      } as const;
    })
  );
}

// ---------------------------------------------------------------------------
// Revoke.
// ---------------------------------------------------------------------------

export type PortalSessionRevokeReason =
  | "USER_LOGOUT"
  | "ADMIN_REVOKED"
  | "PASSWORD_CHANGED"
  | "USER_TERMINATED"
  | "SECURITY_EVENT"
  // The prescriber changed which client practice they are acting for.
  // The old session is revoked and a new one minted rather than the
  // scope being edited in place, so one token means one client for its
  // whole life.
  | "SCOPE_CHANGED";

/** Revoke by raw token (portal logout). Opens its own system-context tx. */
export async function revokePortalSessionByToken(input: {
  readonly rawToken: string;
  readonly reason: PortalSessionRevokeReason;
  readonly client?: TxCapableClient;
  readonly config?: AuthConfiguration;
}): Promise<void> {
  const config = input.config ?? getAuthConfiguration();
  const client = input.client ?? prisma;
  const tokenHash = hashSessionToken(input.rawToken);
  await withSystemContext(REVOKE_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REVOKE_REASON);
      await tx.portalSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: config.clock.now(), revokedReason: input.reason },
      });
    })
  );
}

/**
 * Revoke ALL active sessions for a portal account (password change,
 * account disable). Within a caller-provided transaction.
 */
export async function revokeAllPortalAccountSessionsInTx(input: {
  readonly tx: PortalSessionDelegateClient;
  readonly portalAccountId: string;
  readonly reason: PortalSessionRevokeReason;
  readonly config?: AuthConfiguration;
}): Promise<number> {
  const config = input.config ?? getAuthConfiguration();
  const result = await input.tx.portalSession.updateMany({
    where: { portalAccountId: input.portalAccountId, revokedAt: null },
    data: { revokedAt: config.clock.now(), revokedReason: input.reason },
  });
  return result.count;
}
