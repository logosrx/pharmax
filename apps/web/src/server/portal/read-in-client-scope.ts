// Client-scoped read wrapper for the provider portal.
//
// WHY THIS EXISTS. The Prisma tenancy extension scopes by organization
// and nothing else — `TenantFilterKind` in `@pharmax/tenancy` has
// exactly two members, `organizationId` and `selfOrganization`. Two
// client practices of the same pharmacy share an organizationId, so
// neither the extension nor the RLS policy separates them. A portal
// query that forgets its client filter passes both layers and returns
// every client the prescriber works for.
//
// So the client boundary is enforced here, by convention plus shape:
// the helper hands the callback a ready-made `where` fragment carrying
// BOTH ids. Spreading `filter` into a query is shorter than writing the
// two predicates by hand, which is the only reliable way to make the
// safe path the default one.
//
// This is a convention, not a guarantee — nothing stops a caller
// ignoring `filter`. What makes it workable is that there is exactly
// one helper, so review has a single thing to look for: a portal read
// that does not spread `filter` is the bug.
//
// System context, like every portal read: portal principals have no
// tenancy frame, so the session row is the tenancy proof and each query
// is explicitly scoped.

import "server-only";

import { prisma, type PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import type { PortalIdentityScoped } from "./current-session";

/**
 * The `where` fragment every client-scoped portal query must carry.
 * Spread it: `where: { ...filter, someOtherPredicate }`.
 */
export interface PortalClientFilter {
  readonly organizationId: string;
  readonly clinicId: string;
}

type PortalTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Run `fn` in a system-context transaction with the RLS GUC set,
 * handing it the org+client filter taken from the RESOLVED SESSION.
 *
 * Takes `PortalIdentityScoped` rather than loose ids on purpose: only
 * `getCurrentPortalIdentity` can produce that type, and only when the
 * session actually names a client. A caller cannot reach this helper
 * with a clinic id lifted from a request body.
 */
export function readInClientScope<T>(
  identity: PortalIdentityScoped,
  reason: string,
  fn: (tx: PortalTransactionClient, filter: PortalClientFilter) => Promise<T>
): Promise<T> {
  const filter: PortalClientFilter = Object.freeze({
    organizationId: identity.session.organizationId,
    clinicId: identity.activeClinic.clinicId,
  });

  return withSystemContext(reason, () =>
    prisma.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
      return fn(tx as unknown as PortalTransactionClient, filter);
    })
  );
}
