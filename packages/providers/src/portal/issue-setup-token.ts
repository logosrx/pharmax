// IssuePortalSetupToken — mint a one-time credential-setup token for
// a PENDING_SETUP portal account (ADR-0033, slice 2).
//
// The portal twin of `IssueInvite`. Called post-commit by whoever
// drove the approval (the ops route's onSuccess hook, or the worker
// proofing drain after a non-replayed auto-approval), and reusable
// as an ops "resend setup link" action later. Prior unused tokens
// are invalidated so only the newest link works.
//
// The raw token is RETURNED to the caller (redacted from
// command_log) so it can build the /portal/setup URL and hand it to
// the mailer port. It is persisted only as a SHA-256 hash.

import { hashSessionToken, mintSessionToken } from "@pharmax/auth";
import { executeSystemCommand } from "@pharmax/command-bus";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { PortalAccountStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";
import { z } from "zod";

import {
  PORTAL_ACCOUNT_DISABLED,
  PORTAL_ACCOUNT_NOT_FOUND,
  PORTAL_SETUP_TOKEN_TTL_MS,
} from "./shared.js";

const inputSchema = z
  .object({
    portalAccountId: z.uuid(),
    organizationId: z.uuid(),
  })
  .strict();

export type IssuePortalSetupTokenInput = z.infer<typeof inputSchema>;

export interface IssuePortalSetupTokenOutput {
  readonly rawToken: string;
  readonly expiresAt: Date;
  /** Delivery coordinates for the mailer (office contact; not PHI). */
  readonly email: string;
}

export const IssuePortalSetupToken: SystemCommand<
  IssuePortalSetupTokenInput,
  IssuePortalSetupTokenOutput
> = {
  name: "IssuePortalSetupToken",
  inputSchema,
  redactFields: ["rawToken"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
  }): Promise<SystemHandlerResult<IssuePortalSetupTokenOutput>> {
    const now = clock.now();

    const account = await tx.portalAccount.findUnique({
      where: { id: input.portalAccountId },
      select: { id: true, organizationId: true, email: true, status: true },
    });
    if (account === null || account.organizationId !== input.organizationId) {
      throw new errors.NotFoundError({
        code: PORTAL_ACCOUNT_NOT_FOUND,
        message: "Portal account not found.",
        metadata: { portalAccountId: input.portalAccountId },
      });
    }
    if (account.status === PortalAccountStatus.DISABLED) {
      throw new errors.ConflictError({
        code: PORTAL_ACCOUNT_DISABLED,
        message: "This portal account is disabled; a setup link cannot be issued.",
        metadata: { portalAccountId: input.portalAccountId },
      });
    }

    // Invalidate any prior unused setup token so only the newest
    // link works (mirrors IssueInvite).
    await tx.portalSetupToken.updateMany({
      where: { portalAccountId: account.id, usedAt: null },
      data: { usedAt: now },
    });

    const rawToken = mintSessionToken(32);
    const expiresAt = new Date(now.getTime() + PORTAL_SETUP_TOKEN_TTL_MS);
    await tx.portalSetupToken.create({
      data: {
        organizationId: account.organizationId,
        portalAccountId: account.id,
        tokenHash: hashSessionToken(rawToken),
        expiresAt,
        createdAt: now,
      },
    });

    return {
      output: Object.freeze({ rawToken, expiresAt, email: account.email }),
      targetOrganizationId: account.organizationId,
      audit: {
        action: "portal_account.setup_token_issued",
        resourceType: "PortalAccount",
        resourceId: account.id,
        metadata: {
          portalAccountId: account.id,
          expiresAt: expiresAt.toISOString(),
          commandLogId,
        },
      },
      outboxEvents: [],
    };
  },
};

/** System-context wrapper (mirrors `issueInvite`). */
export async function issuePortalSetupToken(
  input: IssuePortalSetupTokenInput
): Promise<IssuePortalSetupTokenOutput> {
  return withSystemContext("portal:issue-setup-token", () =>
    executeSystemCommand(IssuePortalSetupToken, input)
  );
}
