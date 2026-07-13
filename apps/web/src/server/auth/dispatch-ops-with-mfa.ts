// Privileged-write wrapper around `dispatchOpsCommand` (ADR-0030).
//
// Use for any operator route that mutates billing or org-admin state —
// routes whose RBAC permission is gated on a floor role (OrgAdmin /
// BillingManager). The wrapper enforces the MFA floor BEFORE the command
// bus dispatches. Under the in-house engine the check is a pure,
// in-process test of the session's `mfaSatisfied` flag (MFA was verified
// at sign-in) — no identity-provider round-trip.
//
// On denial we redirect with a structured error code the destination
// route renders as flash text.
//
// PHI invariant: no PHI is read. Flow: session → operator user id +
// role codes + mfaSatisfied → gate.

import "server-only";

import { errors } from "@pharmax/platform-core";
import { NextResponse } from "next/server";

import { dispatchOpsCommand, type DispatchOpsCommandInput } from "../ops/dispatch-from-route.js";
import { logger } from "../logger.js";

import { loadOperatorRoleCodes } from "./load-operator-role-codes.js";
import { enforceOperatorMfa, MFA_REQUIRED } from "./require-mfa.js";
import { resolveOperatorTenancyContext } from "./resolve-tenancy.js";

export type DispatchOpsCommandWithMfaInput<TIn, TOut> = DispatchOpsCommandInput<TIn, TOut>;

export async function dispatchOpsCommandWithMfa<TIn, TOut>(
  input: DispatchOpsCommandWithMfaInput<TIn, TOut>
): Promise<Response> {
  // Step 1 — Resolve operator session.
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.redirect(new URL("/sign-in", "http://internal").toString(), {
      status: 303,
    });
  }

  // Step 2 — Load role codes for the MFA floor check (one indexed JOIN).
  const roleCodes = await loadOperatorRoleCodes({
    organizationId: session.tenancy.organizationId,
    userId: session.tenancy.actor.userId,
  });

  // Step 3 — Enforce the MFA floor against the session. Throws on denial.
  try {
    enforceOperatorMfa({
      userId: session.operator.userId,
      roleCodes,
      mfaSatisfied: session.operator.mfaSatisfied,
    });
  } catch (cause) {
    if (cause instanceof errors.AuthorizationError && cause.code === MFA_REQUIRED) {
      logger.warn(`${input.failureLogEvent}.mfa_denied`, {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        code: cause.code,
      });
      const message =
        "Multi-factor authentication is required for this action. Re-authenticate with your second factor and retry.";
      // failureRedirect may be a thunk (see DispatchOpsCommandInput);
      // at this point buildInput has NOT run, so a thunk falls back
      // to its pre-buildInput default.
      const failureRedirect =
        typeof input.failureRedirect === "function"
          ? input.failureRedirect()
          : input.failureRedirect;
      return NextResponse.redirect(
        new URL(
          `${failureRedirect}?error=${encodeURIComponent(`${cause.code}: ${message}`)}`,
          "http://internal"
        ).toString(),
        { status: 303 }
      );
    }
    throw cause;
  }

  // Step 4 — Delegate to the standard dispatcher (RBAC, tenancy,
  // command-log all inside).
  return await dispatchOpsCommand(input);
}
