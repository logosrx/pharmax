// ChangePortalPassword — authenticated self-service portal password
// change (ADR-0033, slice 3). The portal twin of `@pharmax/auth`'s
// ChangePassword, with the same shape:
//
//   1. Verify the CURRENT password (defeats session-hijack password
//      changes — a stolen portal cookie alone cannot rotate the
//      credential).
//   2. Enforce the operator-grade structural policy + the breach
//      verdict the wrapper computed BEFORE this transaction opened
//      (see @pharmax/auth's password/breach-screen.ts — the breach
//      corpus is a third party and must not be called with a
//      connection held).
//   3. Reject reuse against the `portal_password_history` window
//      (same policy depth operators use). This command is what ADDS
//      portal password history — setup has no prior password by
//      construction.
//   4. Hash (Argon2id, peppered) + store; append to history; prune
//      beyond the policy depth.
//   5. Revoke every OTHER active portal session (PASSWORD_CHANGED)
//      so a stolen session cannot outlive the credential it was born
//      under. The caller keeps its own session via `exceptSessionId`.
//
// A SYSTEM command: portal principals are not tenant actors (no
// `User` row, no RBAC frame), so this runs the same way the other
// portal commands do — `portalAccountId` comes from the RESOLVED
// SESSION in the route handler, never from request input.

import {
  assertPasswordMeetsPolicy,
  getAuthConfiguration,
  logBreachScreenBypass,
  passwordReusedError,
  requireBreachScreen,
  withScreenedPassword,
} from "@pharmax/auth";
import { executeSystemCommand } from "@pharmax/command-bus";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { PortalAccountStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";
import { z } from "zod";

import { PORTAL_CURRENT_PASSWORD_INVALID } from "./shared.js";

const inputSchema = z
  .object({
    /** From the resolved portal session — never from request input. */
    portalAccountId: z.string().uuid(),
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
    /** Keep this session alive; revoke all others. */
    exceptSessionId: z.string().uuid().optional(),
  })
  .strict();

export type ChangePortalPasswordInput = z.infer<typeof inputSchema>;

export interface ChangePortalPasswordOutput {
  readonly portalAccountId: string;
  readonly sessionsRevoked: number;
}

function currentPasswordInvalidError(): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: PORTAL_CURRENT_PASSWORD_INVALID,
    message: "The current password is incorrect.",
  });
}

export const ChangePortalPassword: SystemCommand<
  ChangePortalPasswordInput,
  ChangePortalPasswordOutput
> = {
  name: "ChangePortalPassword",
  inputSchema,
  redactFields: ["currentPassword", "newPassword"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
    logger,
  }): Promise<SystemHandlerResult<ChangePortalPasswordOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();
    const breachScreen = requireBreachScreen(input.newPassword);

    const account = await tx.portalAccount.findUnique({
      where: { id: input.portalAccountId },
      select: {
        id: true,
        organizationId: true,
        providerId: true,
        email: true,
        hashedPassword: true,
        status: true,
      },
    });
    // The route resolved a live session moments ago, so a missing /
    // non-ACTIVE / passwordless account is a race with a disable or
    // an inconsistency — either way the caller gets the same opaque
    // current-password failure (no state enumeration).
    if (
      account === null ||
      account.status !== PortalAccountStatus.ACTIVE ||
      account.hashedPassword === null
    ) {
      throw currentPasswordInvalidError();
    }

    const currentOk = await config.hasher.verify(account.hashedPassword, input.currentPassword);
    if (!currentOk) {
      throw currentPasswordInvalidError();
    }

    // Structural policy + breach screen — identical gates to setup.
    const emailLocalPart = account.email.split("@")[0] ?? "";
    assertPasswordMeetsPolicy({
      plaintext: input.newPassword,
      policy: config.password,
      disallowedSubstrings: [emailLocalPart],
      breachScreen,
    });
    logBreachScreenBypass(logger, breachScreen, { portalAccountId: account.id });

    // Anti-reuse: current hash + the recent history window (same
    // depth as the operator policy).
    const history = await tx.portalPasswordHistory.findMany({
      where: { portalAccountId: account.id },
      orderBy: { createdAt: "desc" },
      take: config.password.historyDepth,
      select: { hashedPassword: true },
    });
    const priorHashes = [account.hashedPassword, ...history.map((h) => h.hashedPassword)];
    for (const priorHash of priorHashes) {
      if (await config.hasher.verify(priorHash, input.newPassword)) {
        throw passwordReusedError();
      }
    }

    const newHash = await config.hasher.hash(input.newPassword);
    await tx.portalAccount.update({
      where: { id: account.id },
      data: { hashedPassword: newHash, updatedAt: now },
      select: { id: true },
    });
    await tx.portalPasswordHistory.create({
      data: {
        organizationId: account.organizationId,
        portalAccountId: account.id,
        hashedPassword: newHash,
        createdAt: now,
      },
    });

    // Prune history beyond the policy depth (keep newest N).
    const keep = await tx.portalPasswordHistory.findMany({
      where: { portalAccountId: account.id },
      orderBy: { createdAt: "desc" },
      take: config.password.historyDepth,
      select: { id: true },
    });
    if (keep.length === config.password.historyDepth) {
      await tx.portalPasswordHistory.deleteMany({
        where: { portalAccountId: account.id, id: { notIn: keep.map((k) => k.id) } },
      });
    }

    // Revoke every other active session for this account.
    const revoked = await tx.portalSession.updateMany({
      where: {
        portalAccountId: account.id,
        revokedAt: null,
        ...(input.exceptSessionId === undefined ? {} : { id: { not: input.exceptSessionId } }),
      },
      data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" },
    });

    return {
      output: Object.freeze({
        portalAccountId: account.id,
        sessionsRevoked: revoked.count,
      }),
      targetOrganizationId: account.organizationId,
      audit: {
        action: "portal_account.password_changed",
        resourceType: "PortalAccount",
        resourceId: account.id,
        metadata: {
          portalAccountId: account.id,
          sessionsRevoked: revoked.count,
          breachScreen: breachScreen.outcome,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.portal_account.password_changed.v1",
          aggregateType: "PortalAccount",
          aggregateId: account.id,
          payload: {
            portalAccountId: account.id,
            organizationId: account.organizationId,
            providerId: account.providerId,
            sessionsRevoked: revoked.count,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};

/**
 * System-context wrapper (mirrors `setupPortalAccount`). Screens the new
 * password before dispatching so the breach lookup never runs inside the
 * command's transaction.
 */
export async function changePortalPassword(
  input: ChangePortalPasswordInput
): Promise<ChangePortalPasswordOutput> {
  return withScreenedPassword(input.newPassword, () =>
    withSystemContext("portal:change-password", () =>
      executeSystemCommand(ChangePortalPassword, input)
    )
  );
}
