// requestPasswordReset — enumeration-safe "forgot password" entry point.
//
// ALWAYS returns void with no observable difference between "email
// exists" and "email doesn't". For a real, ACTIVE user it dispatches
// IssuePasswordReset (mints the token + audit) and hands the raw token
// to the mailer port. For a miss — or any internal failure — it silently
// no-ops. The org is resolved upstream from the sign-in subdomain and
// passed as `organizationId`.

import { UserStatus, prisma, type PrismaClient } from "@pharmax/database";
import { executeSystemCommand } from "@pharmax/command-bus";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { getAuthConfiguration } from "./configure.js";
import { IssuePasswordReset } from "./commands/issue-password-reset.js";

const REASON = "auth:request-password-reset";

export interface RequestPasswordResetInput {
  readonly organizationId: string;
  readonly email: string;
  readonly client?: Pick<PrismaClient, "$transaction">;
}

export async function requestPasswordReset(input: RequestPasswordResetInput): Promise<void> {
  const config = getAuthConfiguration();
  const client = input.client ?? prisma;
  const email = input.email.toLowerCase();

  try {
    await withSystemContext(REASON, async () => {
      const user = await client.$transaction(async (tx) => {
        await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);
        return tx.user.findUnique({
          where: { organizationId_email: { organizationId: input.organizationId, email } },
          select: { id: true, email: true, displayName: true, status: true },
        });
      });

      // Enumeration-safe: unknown or non-active email is a silent no-op.
      if (user === null || user.status !== UserStatus.ACTIVE) {
        return;
      }

      const issued = await executeSystemCommand(IssuePasswordReset, {
        userId: user.id,
        organizationId: input.organizationId,
      });

      // Hand the raw token to the delivery port. The token is never
      // persisted in plaintext; the mailer builds the reset link and
      // owns its own transport error handling.
      await config.passwordResetMailer.sendPasswordReset({
        kind: "reset",
        email: user.email,
        displayName: user.displayName,
        rawToken: issued.rawToken,
        expiresAt: issued.expiresAt,
        organizationId: input.organizationId,
        userId: user.id,
      });
    });
  } catch {
    // Never surface internal state to the caller — a thrown error here
    // (DB, mailer) would let an attacker distinguish existing accounts.
    // The mailer adapter and the bus log their own failures.
  }
}
