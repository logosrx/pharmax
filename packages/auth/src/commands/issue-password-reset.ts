// IssuePasswordReset — mint a single-use reset token for a KNOWN user.
//
// A SYSTEM command: it is dispatched by the `requestPasswordReset`
// orchestration ONLY after that wrapper has resolved a real, ACTIVE
// user (so the org is known). The enumeration-safety decision — never
// reveal whether an email exists — lives in the wrapper, which calls
// this command for a hit and silently no-ops for a miss.
//
// The raw token is RETURNED to the wrapper (redacted from command_log)
// so it can be handed to the mailer port. It is persisted ONLY as a
// SHA-256 hash; the outbox event is token-free.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { hashSessionToken, mintSessionToken } from "../session/token.js";

const inputSchema = z
  .object({
    userId: z.string().uuid(),
    organizationId: z.string().uuid(),
  })
  .strict();

export type IssuePasswordResetInput = z.infer<typeof inputSchema>;

export interface IssuePasswordResetOutput {
  /** Raw reset token — redacted from command_log; handed to the mailer. */
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export const IssuePasswordReset: SystemCommand<IssuePasswordResetInput, IssuePasswordResetOutput> =
  {
    name: "IssuePasswordReset",
    inputSchema,
    redactFields: ["rawToken"],

    async handle({
      input,
      tx,
      commandLogId,
      clock,
    }): Promise<SystemHandlerResult<IssuePasswordResetOutput>> {
      const config = getAuthConfiguration();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + config.resetTokenTtlMs);

      // Invalidate any prior unused tokens so only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: input.userId, usedAt: null },
        data: { usedAt: now },
      });

      const rawToken = mintSessionToken(32);
      await tx.passwordResetToken.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId,
          tokenHash: hashSessionToken(rawToken),
          expiresAt,
          createdAt: now,
        },
      });

      return {
        output: Object.freeze({ rawToken, expiresAt }),
        targetOrganizationId: input.organizationId,
        audit: {
          action: "user.password_reset_requested",
          resourceType: "User",
          resourceId: input.userId,
          // Token-free: only the fact + expiry are audited.
          metadata: { userId: input.userId, expiresAt: expiresAt.toISOString(), commandLogId },
        },
        outboxEvents: [
          {
            eventType: "user.password_reset_requested.v1",
            aggregateType: "User",
            aggregateId: input.userId,
            payload: {
              organizationId: input.organizationId,
              userId: input.userId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
