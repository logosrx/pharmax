// MFA enforcement for privileged operator roles.
//
// HIPAA Security Rule § 164.308(a)(5)(ii)(D) and SOC 2 CC6.1
// expect a second authentication factor for accounts that can
// access or modify protected health information OR sensitive
// financial data. Pharmax enforces this for two role codes:
//
//   - `OrgAdmin`       — full administrative reach over the org.
//   - `BillingManager` — invoice + pricing administration.
//
// Other roles (Pharmacist, PharmacyTechnician, ShippingClerk,
// ClinicViewer, WebhookService) are NOT auto-required to use
// MFA at this gate. Operators with those roles SHOULD still
// enable MFA, and customer-side admins MAY require it via
// Clerk's organization policy; this module enforces only the
// floor that the platform itself owns.
//
// How the gate works:
//
//   1. After `resolveOperatorTenancyContext` returns ok=true,
//      callers fetch the operator's role codes (via the RBAC
//      loader) and pass them to `requireOperatorMfa(...)`.
//   2. If none of the operator's roles is on the MFA-required
//      list, the gate is `mfa_not_required` — proceed.
//   3. Otherwise we ask Clerk how many enrolled second factors
//      the user has. Zero ⇒ `mfa_required_not_enrolled`. One
//      or more ⇒ `mfa_satisfied`. Callers translate the
//      result into the right UX (forced enrollment redirect
//      or 403 with a structured error code).
//
// Per-request memoization:
//
//   `requireOperatorMfa` is a network call to Clerk Backend API.
//   Within the SAME server-component / route-handler render tree,
//   multiple call sites may evaluate the gate (e.g. layout +
//   nested page + a few protected actions). We wrap the lookup in
//   `React.cache` so the call is deduped per request — without
//   that, a single render could fire three Clerk API calls in
//   quick succession.
//
//   `React.cache` is request-scoped on the server: Next allocates
//   a fresh cache per RSC request, so cross-request leakage is
//   impossible by construction.
//
// We rely on Clerk Backend SDK's `users.getUser(id)` to read
// `two_factor_enabled` / `totp_enabled` / `backup_code_enabled`.
// Clerk's organization-level policy CAN ALSO require MFA — we
// recommend turning that on in the Clerk dashboard for defence
// in depth — but this code does not depend on that policy
// being present.
//
// Test injectability: every external dependency (Clerk client,
// role codes) is taken via options so unit tests can run
// without network or a database.

import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { errors } from "@pharmax/platform-core";
import { cache } from "react";

import { logger } from "../logger.js";

/**
 * Role codes that the platform forces MFA on, regardless of
 * org-level policy. Kept tight — every code on this list is a
 * justified privilege escalation we are not willing to grant
 * to a single-factor account.
 *
 * Case-sensitive by design: role codes are referenced by their
 * canonical PascalCase form everywhere (RBAC seed, command
 * inputs, audit_log). Adding lower-cased lookalikes here would
 * silently widen the floor — leave it tight.
 */
export const MFA_REQUIRED_ROLE_CODES: ReadonlySet<string> = Object.freeze(
  new Set<string>(["OrgAdmin", "BillingManager"])
);

export type MfaGateOutcome =
  | { readonly status: "mfa_not_required" }
  | { readonly status: "mfa_satisfied"; readonly factorCount: number }
  | {
      readonly status: "mfa_required_not_enrolled";
      readonly enforcingRoleCodes: ReadonlyArray<string>;
    }
  | {
      readonly status: "mfa_lookup_failed";
      readonly enforcingRoleCodes: ReadonlyArray<string>;
      readonly error: string;
    };

/**
 * Minimal Clerk user shape that we read for MFA evaluation.
 * Mirrors the Clerk Backend SDK return type without dragging
 * the full type into our public surface.
 */
export interface ClerkUserMfaSnapshot {
  readonly twoFactorEnabled: boolean;
  readonly totpEnabled: boolean;
  readonly backupCodeEnabled: boolean;
  readonly verifiedPhoneNumberId?: string | null;
}

export interface RequireMfaOptions {
  /**
   * Lookup hook for the Clerk user's MFA state. Defaults to the
   * real `clerkClient().users.getUser(...)` (the cached version
   * is used when `options` is omitted; passing a getter here
   * bypasses the cache, which is what tests want).
   */
  readonly getClerkUserMfa?: (clerkUserId: string) => Promise<ClerkUserMfaSnapshot>;
}

/**
 * Public gate. Resolves an MFA outcome for the (clerkUserId,
 * roleCodes) pair. Idempotent within the request scope when no
 * `options.getClerkUserMfa` is passed — `React.cache` dedupes
 * the underlying Clerk Backend API call per (request, user) pair.
 */
export async function requireOperatorMfa(input: {
  readonly clerkUserId: string;
  readonly roleCodes: ReadonlyArray<string>;
  readonly options?: RequireMfaOptions;
}): Promise<MfaGateOutcome> {
  const enforcing = input.roleCodes.filter((c) => MFA_REQUIRED_ROLE_CODES.has(c));
  if (enforcing.length === 0) {
    return Object.freeze({ status: "mfa_not_required" } as const);
  }

  // Tests inject `getClerkUserMfa` directly to bypass the cache
  // and the real SDK. Production callers omit it, so the cached
  // wrapper handles the dedupe.
  const getter = input.options?.getClerkUserMfa ?? cachedClerkMfaLookup;

  let snapshot: ClerkUserMfaSnapshot;
  try {
    snapshot = await getter(input.clerkUserId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.warn("auth.mfa.lookup_failed", {
      event: "auth.mfa.lookup_failed",
      clerkUserId: input.clerkUserId,
      enforcingRoleCodes: enforcing,
      error: message,
    });
    return Object.freeze({
      status: "mfa_lookup_failed",
      enforcingRoleCodes: Object.freeze([...enforcing]),
      error: message,
    } as const);
  }

  const factorCount = countMfaFactors(snapshot);
  if (factorCount === 0) {
    logger.warn("auth.mfa.required_not_enrolled", {
      event: "auth.mfa.required_not_enrolled",
      clerkUserId: input.clerkUserId,
      enforcingRoleCodes: enforcing,
    });
    return Object.freeze({
      status: "mfa_required_not_enrolled",
      enforcingRoleCodes: Object.freeze([...enforcing]),
    } as const);
  }

  return Object.freeze({ status: "mfa_satisfied", factorCount } as const);
}

export function countMfaFactors(snapshot: ClerkUserMfaSnapshot): number {
  let n = 0;
  if (snapshot.totpEnabled) n += 1;
  if (snapshot.backupCodeEnabled) n += 1;
  // Clerk's `twoFactorEnabled` is a roll-up; if it's true but the
  // specific factor flags are false, count it once so callers see
  // a non-zero result. (Clerk may add factor types in the future
  // that this code doesn't enumerate yet.)
  if (snapshot.twoFactorEnabled && n === 0) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Per-request memoization.
//
// `React.cache` produces a function whose return value is cached for
// the lifetime of the React server-component request. Two call sites
// inside the same render hit the cache; the next request gets a
// fresh cache. This is the recommended Next.js pattern for
// server-side memoization that doesn't leak across requests.
// ---------------------------------------------------------------------------

/**
 * Cached Clerk MFA lookup. `cache(...)` returns a memoizing wrapper
 * that survives within one request and is re-allocated per request.
 *
 * Exported for tests that want to drive the cached path directly.
 * Production code should call `requireOperatorMfa(...)` and let it
 * pick the right getter.
 */
export const cachedClerkMfaLookup = cache(
  async (clerkUserId: string): Promise<ClerkUserMfaSnapshot> => {
    return await defaultClerkMfaLookup(clerkUserId);
  }
);

async function defaultClerkMfaLookup(clerkUserId: string): Promise<ClerkUserMfaSnapshot> {
  const client = await clerkClient();
  const user = await client.users.getUser(clerkUserId);
  return Object.freeze({
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
    totpEnabled: Boolean(user.totpEnabled),
    backupCodeEnabled: Boolean(user.backupCodeEnabled),
  });
}

// ---------------------------------------------------------------------------
// `enforceMfaForCommand` — throws on denial.
//
// Wraps `requireOperatorMfa` with a side that fits the command-bus's
// thrown-error contract. Callers use this in route handlers and
// server actions BEFORE dispatching a privileged write so the bus
// never sees the dispatch when the gate denies.
//
// Outcome → behavior:
//
//   mfa_not_required           → return (no-op, allow).
//   mfa_satisfied              → return (allow).
//   mfa_required_not_enrolled  → throw `MFA_REQUIRED` (403).
//   mfa_lookup_failed          → throw `MFA_LOOKUP_FAILED` (503).
//                                Callers that want fail-open semantics
//                                (read paths) should NOT use this
//                                helper — they should branch on the
//                                outcome themselves.
// ---------------------------------------------------------------------------

export const MFA_REQUIRED = "MFA_REQUIRED" as const;
export const MFA_LOOKUP_FAILED = "MFA_LOOKUP_FAILED" as const;

export class MfaRequiredError extends errors.AuthorizationError {
  public readonly enforcingRoleCodes: ReadonlyArray<string>;

  public constructor(detail: {
    readonly clerkUserId: string;
    readonly enforcingRoleCodes: ReadonlyArray<string>;
  }) {
    super({
      code: MFA_REQUIRED,
      message:
        "Multi-factor authentication is required for this action. Enroll a second factor and retry.",
      metadata: {
        // Synthetic identifier; not PHI.
        clerkUserId: detail.clerkUserId,
        enforcingRoleCodes: detail.enforcingRoleCodes,
      },
    });
    this.enforcingRoleCodes = Object.freeze([...detail.enforcingRoleCodes]);
  }
}

export class MfaLookupFailedError extends errors.AuthorizationError {
  public readonly enforcingRoleCodes: ReadonlyArray<string>;

  public constructor(detail: {
    readonly clerkUserId: string;
    readonly enforcingRoleCodes: ReadonlyArray<string>;
    readonly cause: string;
  }) {
    super({
      code: MFA_LOOKUP_FAILED,
      message:
        "Could not verify multi-factor authentication. Try again; if it persists, contact your administrator.",
      metadata: {
        clerkUserId: detail.clerkUserId,
        enforcingRoleCodes: detail.enforcingRoleCodes,
        cause: detail.cause,
      },
    });
    this.enforcingRoleCodes = Object.freeze([...detail.enforcingRoleCodes]);
  }
}

/**
 * Throw-on-denial wrapper. Use BEFORE dispatching a privileged
 * write (billing, admin). The bus's expected-error mapping
 * surfaces the structured code to the route handler so it can
 * redirect to the enrollment flow or render a 403.
 */
export async function enforceMfaForCommand(input: {
  readonly clerkUserId: string;
  readonly roleCodes: ReadonlyArray<string>;
  readonly options?: RequireMfaOptions;
}): Promise<void> {
  const outcome = await requireOperatorMfa(input);
  switch (outcome.status) {
    case "mfa_not_required":
    case "mfa_satisfied":
      return;
    case "mfa_required_not_enrolled":
      throw new MfaRequiredError({
        clerkUserId: input.clerkUserId,
        enforcingRoleCodes: outcome.enforcingRoleCodes,
      });
    case "mfa_lookup_failed":
      throw new MfaLookupFailedError({
        clerkUserId: input.clerkUserId,
        enforcingRoleCodes: outcome.enforcingRoleCodes,
        cause: outcome.error,
      });
    default: {
      // Exhaustiveness check: if a future case is added to
      // MfaGateOutcome, TypeScript flags this branch.
      const _exhaustive: never = outcome;
      void _exhaustive;
      throw new Error("enforceMfaForCommand: unreachable");
    }
  }
}
