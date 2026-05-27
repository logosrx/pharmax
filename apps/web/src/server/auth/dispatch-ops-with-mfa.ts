// Privileged-write wrapper around `dispatchOpsCommand`.
//
// Use for any operator route that mutates billing or org-admin
// state — i.e. routes whose RBAC permission is gated on a role
// in `MFA_REQUIRED_ROLE_CODES` (today: `OrgAdmin` /
// `BillingManager`). The wrapper enforces the MFA floor BEFORE
// the command bus dispatches; on denial we redirect with a
// structured error code that the destination route can render
// as flash text.
//
// Why this shape:
//
//   - The base `dispatchOpsCommand` handles RBAC inside the
//     command (it dispatches via `executeCommand` which calls the
//     bus's RBAC + SoD checks). MFA enforcement is a separate
//     concern that lives at the Clerk identity layer; the bus
//     does not know about Clerk users.
//
//   - Putting the MFA gate in `proxy.ts` would burn a Clerk
//     Backend API call on EVERY authenticated request — not just
//     privileged writes. Call-site enforcement keeps the cost
//     proportional to the privilege being exercised.
//
//   - Keeping the wrapper in `apps/web/src/server/auth/` keeps the
//     ESLint Override 3c boundary intact: the auth folder is the
//     single legitimate home for Clerk-aware server code.
//
// PHI invariant: no PHI is read. The flow is: Clerk session →
// operator user_id → role codes → MFA gate. Nothing here touches
// patient or order data.

import "server-only";

import { errors } from "@pharmax/platform-core";
import { NextResponse } from "next/server";

import { dispatchOpsCommand, type DispatchOpsCommandInput } from "../ops/dispatch-from-route.js";
import { logger } from "../logger.js";

import { loadOperatorRoleCodes } from "./load-operator-role-codes.js";
import {
  enforceMfaForCommand,
  MFA_LOOKUP_FAILED,
  MFA_REQUIRED,
  type RequireMfaOptions,
} from "./require-mfa.js";
import { resolveOperatorTenancyContext } from "./resolve-tenancy.js";

export interface DispatchOpsCommandWithMfaInput<TIn, TOut> extends DispatchOpsCommandInput<
  TIn,
  TOut
> {
  /**
   * Optional MFA hooks override. Tests pass `getClerkUserMfa` to
   * stub out the Clerk Backend SDK call. Production code omits
   * this and the gate's `React.cache`-backed default runs.
   */
  readonly mfaOptions?: RequireMfaOptions;
}

export async function dispatchOpsCommandWithMfa<TIn, TOut>(
  input: DispatchOpsCommandWithMfaInput<TIn, TOut>
): Promise<Response> {
  // Step 1 — Resolve operator session.
  //
  // `dispatchOpsCommand` resolves session itself; we resolve a
  // first time here for the MFA gate. The cost is one Clerk
  // `auth()` call + one DB findUnique — both negligible compared
  // to the eventual command-bus tx. We keep the resolutions
  // independent rather than threading a session object through
  // the dispatcher's signature (which we don't own).
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    // Match `dispatchOpsCommand`'s no-session branch: redirect to
    // sign-in. The message page handles "linked but not active"
    // separately at the layout layer.
    return NextResponse.redirect(new URL("/sign-in", "http://internal").toString(), {
      status: 303,
    });
  }

  // Step 2 — Load role codes for the MFA floor check.
  //
  // The loader only returns role codes — it does NOT resolve the
  // full RBAC grant graph. The bus will do that when it enforces
  // the per-permission grants below. Cheap: one indexed JOIN.
  const roleCodes = await loadOperatorRoleCodes({
    organizationId: session.tenancy.organizationId,
    userId: session.tenancy.actor.userId,
  });

  // Step 3 — Enforce MFA. Throws on denial; the catch maps to a
  // flash-error redirect.
  try {
    await enforceMfaForCommand({
      clerkUserId: session.operator.clerkUserId,
      roleCodes,
      ...(input.mfaOptions !== undefined ? { options: input.mfaOptions } : {}),
    });
  } catch (cause) {
    if (cause instanceof errors.AuthorizationError) {
      const code = cause.code;
      logger.warn(`${input.failureLogEvent}.mfa_denied`, {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        code,
      });
      const message =
        code === MFA_REQUIRED
          ? "Multi-factor authentication is required for this action. Enroll a second factor and retry."
          : code === MFA_LOOKUP_FAILED
            ? "Could not verify multi-factor authentication. Try again; contact your admin if it persists."
            : cause.message;
      return NextResponse.redirect(
        new URL(
          `${input.failureRedirect}?error=${encodeURIComponent(`${code}: ${message}`)}`,
          "http://internal"
        ).toString(),
        { status: 303 }
      );
    }
    // Unexpected — re-throw so the global handler logs to Sentry.
    throw cause;
  }

  // Step 4 — Delegate to the standard dispatcher. All RBAC,
  // tenancy, and command-log machinery happens inside.
  return await dispatchOpsCommand(input);
}
