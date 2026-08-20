// Current portal session resolution for /portal server components and
// route handlers (ADR-0033, slice 2) — the portal twin of the operator
// current-session helper.
//
// Reads the portal cookie, resolves it through the stateful portal
// session engine (idle/absolute checks + immediate revocation), and on
// success loads the provider identity the session belongs to. All in
// system context — the session row IS the tenancy proof.
//
// CLIENT SCOPE. A prescriber commonly writes for several client
// practices, and the client decides which orders are visible and which
// client is invoiced. That scope lives on the session row, because a
// clinic id in a request is caller-controlled.
//
// The resolved identity is therefore a DISCRIMINATED UNION rather than
// one shape with a nullable field:
//
//   { kind: "scoped" }    has activeClinic; may read data
//   { kind: "unscoped" }  authenticated, has not chosen yet
//
// Data-reading surfaces accept only `PortalIdentityScoped`, so
// "forgot to check whether a client was selected" is a type error
// rather than a query that quietly reads across every client the
// prescriber works for. Only the chooser accepts the unscoped variant.
// A nullable `activeClinicId` on a single shape would compile fine at
// every call site that ignored it, which is precisely the bug worth
// making impossible.

import "server-only";

import { prisma, type PrismaClient } from "@pharmax/database";
import {
  listPortalClinicOptions,
  resolvePortalSession,
  type PortalClinicOption,
  type ResolvedPortalSession,
} from "@pharmax/providers";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { readPortalSessionTokenFromCookies } from "./session-cookie";

const LOAD_REASON = "portal:load-identity";

export interface PortalAccountIdentity {
  readonly id: string;
  readonly email: string;
  readonly applicationId: string | null;
}

export interface PortalProviderIdentity {
  readonly id: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly status: string;
}

interface PortalIdentityBase {
  readonly session: ResolvedPortalSession;
  readonly account: PortalAccountIdentity;
  readonly provider: PortalProviderIdentity;
  /**
   * Every client this prescriber may act for. Present on both variants:
   * the chooser needs it to render, and a scoped session needs it to
   * decide whether to show a switcher at all.
   */
  readonly clinicOptions: ReadonlyArray<PortalClinicOption>;
}

/** Authenticated AND scoped to one client. The only shape that may read data. */
export interface PortalIdentityScoped extends PortalIdentityBase {
  readonly kind: "scoped";
  readonly activeClinic: PortalClinicOption;
}

/** Authenticated, several clients available, none chosen yet. */
export interface PortalIdentityUnscoped extends PortalIdentityBase {
  readonly kind: "unscoped";
}

export type PortalIdentity = PortalIdentityScoped | PortalIdentityUnscoped;

/**
 * Resolve the current portal identity from the request cookies, or null
 * when there is no valid portal session. Callers redirect to
 * /portal/sign-in on null, and to /portal/select-client when the result
 * is `unscoped`.
 */
export async function getCurrentPortalIdentity(
  client: Pick<PrismaClient, "$transaction"> = prisma
): Promise<PortalIdentity | null> {
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

      const clinicOptions = await listPortalClinicOptions({
        tx,
        organizationId: session.organizationId,
        providerId: account.provider.id,
      });

      const base = {
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
        clinicOptions,
      } satisfies PortalIdentityBase;

      if (session.activeClinicId === null) {
        return { kind: "unscoped", ...base } satisfies PortalIdentityUnscoped;
      }

      // The session names a client, so it must appear in the options —
      // the session engine already re-proves the affiliation on every
      // resolve, so a miss here means the two disagree. Treat it as no
      // session rather than guessing: downgrading to `unscoped` would
      // send the prescriber to a chooser that cannot offer the client
      // they were using, with no explanation.
      const activeClinic = clinicOptions.find((c) => c.clinicId === session.activeClinicId);
      if (activeClinic === undefined) return null;

      return { kind: "scoped", ...base, activeClinic } satisfies PortalIdentityScoped;
    })
  );
}
