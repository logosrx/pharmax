// SetupPortalAccount — consume a one-time setup token, set the
// initial portal password, and activate a PENDING_SETUP portal
// account (ADR-0033, slice 2). The portal twin of `AcceptInvite`.
//
// A SYSTEM command: pre-auth (the caller holds only the emailed
// token). The token resolves to the account + org; the command
// requires the account to be PENDING_SETUP — a consumed/expired
// token, or an account already ACTIVE/DISABLED, is an opaque
// PORTAL_SETUP_TOKEN_INVALID (no enumeration). On success it
// validates the password against the same structural + breach
// policy operators get, hashes with the process Argon2id hasher
// (pepper included), flips PENDING_SETUP → ACTIVE, and consumes the
// token. It does NOT mint a session — the prescriber signs in
// normally afterwards.
//
// The breach half of that policy is decided BEFORE this transaction
// opens: it is a third-party lookup, and the wrapper below runs it so
// no database connection is held across the call. See
// @pharmax/auth's password/breach-screen.ts.
//
// No password history: a PENDING_SETUP account has no prior
// password by construction, and portal password CHANGE is a slice-3
// concern (it will add history when it lands).

import {
  assertPasswordMeetsPolicy,
  getAuthConfiguration,
  hashSessionToken,
  logBreachScreenBypass,
  requireBreachScreen,
  withScreenedPassword,
} from "@pharmax/auth";
import { executeSystemCommand } from "@pharmax/command-bus";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { PortalAccountStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";
import { z } from "zod";

import { PORTAL_SETUP_TOKEN_INVALID } from "./shared.js";

const inputSchema = z
  .object({
    rawToken: z.string().min(1).max(512),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

export type SetupPortalAccountInput = z.infer<typeof inputSchema>;

export interface SetupPortalAccountOutput {
  readonly portalAccountId: string;
  readonly organizationId: string;
}

function setupTokenInvalidError(): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: PORTAL_SETUP_TOKEN_INVALID,
    message: "This setup link is invalid or has expired.",
  });
}

export const SetupPortalAccount: SystemCommand<SetupPortalAccountInput, SetupPortalAccountOutput> =
  {
    name: "SetupPortalAccount",
    inputSchema,
    redactFields: ["rawToken", "newPassword"],

    async handle({
      input,
      tx,
      commandLogId,
      clock,
      logger,
    }): Promise<SystemHandlerResult<SetupPortalAccountOutput>> {
      const config = getAuthConfiguration();
      const now = clock.now();
      const breachScreen = requireBreachScreen(input.newPassword);

      const token = await tx.portalSetupToken.findUnique({
        where: { tokenHash: hashSessionToken(input.rawToken) },
        select: {
          id: true,
          portalAccountId: true,
          organizationId: true,
          expiresAt: true,
          usedAt: true,
        },
      });
      if (token === null || token.usedAt !== null || token.expiresAt.getTime() <= now.getTime()) {
        throw setupTokenInvalidError();
      }

      const account = await tx.portalAccount.findUnique({
        where: { id: token.portalAccountId },
        select: { id: true, email: true, status: true, providerId: true },
      });
      // Setup applies only to a still-PENDING_SETUP account. Anything
      // else (already ACTIVE, DISABLED) is the same opaque invalid
      // token — no enumeration.
      if (account === null || account.status !== PortalAccountStatus.PENDING_SETUP) {
        throw setupTokenInvalidError();
      }

      // Same structural + breach policy as operator passwords. No
      // reuse-history check — a PENDING_SETUP account has none.
      const emailLocalPart = account.email.split("@")[0] ?? "";
      assertPasswordMeetsPolicy({
        plaintext: input.newPassword,
        policy: config.password,
        disallowedSubstrings: [emailLocalPart],
        breachScreen,
      });
      logBreachScreenBypass(logger, breachScreen, { portalAccountId: account.id });

      const hashedPassword = await config.hasher.hash(input.newPassword);
      await tx.portalAccount.update({
        where: { id: account.id },
        data: { hashedPassword, status: PortalAccountStatus.ACTIVE, updatedAt: now },
        select: { id: true },
      });
      await tx.portalSetupToken.update({ where: { id: token.id }, data: { usedAt: now } });

      return {
        output: Object.freeze({
          portalAccountId: account.id,
          organizationId: token.organizationId,
        }),
        targetOrganizationId: token.organizationId,
        audit: {
          action: "portal_account.activated",
          resourceType: "PortalAccount",
          resourceId: account.id,
          metadata: {
            portalAccountId: account.id,
            breachScreen: breachScreen.outcome,
            commandLogId,
          },
        },
        outboxEvents: [
          {
            eventType: "provider.portal_account.activated.v1",
            aggregateType: "PortalAccount",
            aggregateId: account.id,
            payload: {
              portalAccountId: account.id,
              organizationId: token.organizationId,
              providerId: account.providerId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };

/**
 * System-context wrapper (mirrors `acceptInvite`). Screens the chosen
 * password against the breach corpus BEFORE dispatching, so that
 * third-party call never runs with the command's transaction open.
 */
export async function setupPortalAccount(
  input: SetupPortalAccountInput
): Promise<SetupPortalAccountOutput> {
  return withScreenedPassword(input.newPassword, () =>
    withSystemContext("portal:setup-account", () => executeSystemCommand(SetupPortalAccount, input))
  );
}
