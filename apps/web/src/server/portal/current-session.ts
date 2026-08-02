// Current portal session resolution for /portal server components and
// route handlers (ADR-0033, slice 2) — the portal twin of the operator
// current-session helper.
//
// Reads the portal cookie, resolves it through the stateful portal
// session engine (idle/absolute checks + immediate revocation), and on
// success loads the provider identity the session belongs to. All in
// system context — the session row IS the tenancy proof.

import "server-only";

import { prisma, type PrismaClient } from "@pharmax/database";
import { resolvePortalSession, type ResolvedPortalSession } from "@pharmax/providers";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { readPortalSessionTokenFromCookies } from "./session-cookie";

const LOAD_REASON = "portal:load-identity";

export interface CurrentPortalIdentity {
  readonly session: ResolvedPortalSession;
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly applicationId: string | null;
  };
  readonly provider: {
    readonly id: string;
    readonly npi: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly credential: string | null;
    readonly status: string;
  };
}

/**
 * Resolve the current portal identity from the request cookies, or null
 * when there is no valid portal session. Callers redirect to
 * /portal/sign-in on null.
 */
export async function getCurrentPortalIdentity(
  client: Pick<PrismaClient, "$transaction"> = prisma
): Promise<CurrentPortalIdentity | null> {
  const rawToken = await readPortalSessionTokenFromCookies();
  if (rawToken === null) return null;

  const resolution = await resolvePortalSession({ rawToken, client });
  if (!resolution.ok) return null;
  const session = resolution.session;

  return withSystemContext(LOAD_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, LOAD_REASON);
      const account = await tx.portalAccount.findUnique({
        where: { id: session.portalAccountId },
        select: {
          id: true,
          email: true,
          applicationId: true,
          provider: {
            select: {
              id: true,
              npi: true,
              firstName: true,
              lastName: true,
              credential: true,
              status: true,
            },
          },
        },
      });
      if (account === null) return null;
      return {
        session,
        account: {
          id: account.id,
          email: account.email,
          applicationId: account.applicationId,
        },
        provider: {
          id: account.provider.id,
          npi: account.provider.npi,
          firstName: account.provider.firstName,
          lastName: account.provider.lastName,
          credential: account.provider.credential,
          status: account.provider.status,
        },
      };
    })
  );
}
