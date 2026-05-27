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

import { auth } from "@clerk/nextjs/server";
import { prisma, UserStatus } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";
import { buildTenancyContext, withSystemContext, type TenancyContext } from "@pharmax/tenancy";

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
  readonly client?: {
    readonly user: {
      readonly findUnique: (args: {
        where: { clerkUserId: string };
        select: {
          id: true;
          organizationId: true;
          email: true;
          displayName: true;
          status: true;
          clerkUserId: true;
        };
      }) => Promise<{
        id: string;
        organizationId: string;
        email: string;
        displayName: string;
        status: UserStatus;
        clerkUserId: string | null;
      } | null>;
    };
  };
}

export async function resolveOperatorTenancyContext(
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
  const user = await withSystemContext("apps/web:resolve-operator-tenancy", async () =>
    client.user.findUnique({
      where: { clerkUserId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        displayName: true,
        status: true,
        clerkUserId: true,
      },
    })
  );

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
