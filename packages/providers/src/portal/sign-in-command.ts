// PortalSignIn — the successful portal-authentication command
// (ADR-0033, slice 2). The PortalAccount twin of `SignIn`.
//
// A SYSTEM command: at sign-in there is no tenancy context yet; the
// web tier resolves the org from the organization slug and passes
// `organizationId`. Success writes command_log + audit_log
// ("portal_account.signed_in") + event_outbox
// ("provider.portal_account.signed_in.v1"). Any failure (bad
// password, non-ACTIVE account) THROWS the same opaque
// INVALID_CREDENTIALS the operator engine uses — no enumeration —
// and the `portalSignIn` orchestrator records it in the
// login_attempt ledger.
//
// MFA: deliberately none in v1. The portal's post-approval
// capability is read access to the prescriber's OWN data; the MFA
// floor (ADR-0025) is scoped to privileged operator roles. Revisit
// when the portal gains order-creation rights (tracked in
// ADR-0033's slice-3 note).

import { getAuthConfiguration, invalidCredentialsError } from "@pharmax/auth";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { PortalAccountStatus } from "@pharmax/database";
import { z } from "zod";

import { createPortalSessionInTx } from "./session.js";

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    email: z.email().max(320),
    password: z.string().min(1).max(1024),
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

export type PortalSignInInput = z.infer<typeof inputSchema>;

export interface PortalSignInOutput {
  readonly portalAccountId: string;
  readonly providerId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  /** Bearer session token. Redacted from command_log; returned to caller. */
  readonly rawToken: string;
}

export const PortalSignIn: SystemCommand<PortalSignInInput, PortalSignInOutput> = {
  name: "PortalSignIn",
  inputSchema,
  redactFields: ["password", "rawToken"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
  }): Promise<SystemHandlerResult<PortalSignInOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();
    const email = input.email.toLowerCase();

    const account = await tx.portalAccount.findUnique({
      where: { organizationId_email: { organizationId: input.organizationId, email } },
      select: { id: true, providerId: true, status: true, hashedPassword: true },
    });

    if (account === null) {
      throw invalidCredentialsError("portal_account_not_found");
    }
    if (account.status !== PortalAccountStatus.ACTIVE) {
      throw invalidCredentialsError("portal_account_not_active");
    }
    if (account.hashedPassword === null) {
      // PENDING_SETUP accounts are caught by the status gate; this is
      // a defensive impossible-state guard.
      throw invalidCredentialsError("portal_no_password_set");
    }

    const passwordOk = await config.hasher.verify(account.hashedPassword, input.password);
    if (!passwordOk) {
      throw invalidCredentialsError("bad_password");
    }

    // Transparent KDF upgrade, same as the operator engine.
    let rehashed = false;
    if (config.hasher.needsRehash(account.hashedPassword)) {
      const upgraded = await config.hasher.hash(input.password);
      await tx.portalAccount.update({
        where: { id: account.id },
        data: { hashedPassword: upgraded },
      });
      rehashed = true;
    }

    const session = await createPortalSessionInTx({
      tx,
      portalAccountId: account.id,
      organizationId: input.organizationId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      config,
    });

    await tx.portalAccount.update({
      where: { id: account.id },
      data: { lastLoginAt: now },
    });

    return {
      output: {
        portalAccountId: account.id,
        providerId: account.providerId,
        organizationId: input.organizationId,
        sessionId: session.sessionId,
        rawToken: session.rawToken,
      },
      targetOrganizationId: input.organizationId,
      audit: {
        action: "portal_account.signed_in",
        resourceType: "PortalAccount",
        resourceId: account.id,
        metadata: { commandLogId, rehashed },
      },
      outboxEvents: [
        {
          eventType: "provider.portal_account.signed_in.v1",
          aggregateType: "PortalAccount",
          aggregateId: account.id,
          payload: {
            portalAccountId: account.id,
            organizationId: input.organizationId,
            providerId: account.providerId,
            sessionId: session.sessionId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
