// DeactivateUser — off-board an operator (ADR-0030).
//
// Replaces the old Clerk `user.deleted` webhook: an admin suspends or
// terminates a user, and the command flips their status AND revokes all
// their active sessions in the same transaction — so the next request
// from any stale session is rejected at `resolveSession`. Immediate,
// because sessions are stateful.
//
// Tenant command gated on `users.manage`. An admin cannot deactivate
// their own account (self-lockout guard). Session revocation uses
// USER_TERMINATED as the reason for the audit trail.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { revokeAllUserSessionsInTx } from "../session/service.js";

const inputSchema = z
  .object({
    targetUserId: z.string().uuid(),
    status: z.enum(["SUSPENDED", "TERMINATED"]),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type DeactivateUserInput = z.infer<typeof inputSchema>;

export interface DeactivateUserOutput {
  readonly targetUserId: string;
  readonly status: UserStatus;
  readonly sessionsRevoked: number;
}

export const DeactivateUser: Command<DeactivateUserInput, DeactivateUserOutput> = {
  name: "DeactivateUser",
  inputSchema,
  permission: PERMISSIONS.USERS_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<DeactivateUserOutput>> {
    const now = clock.now();

    if (input.targetUserId === ctx.actor.userId) {
      throw new errors.ConflictError({
        code: "CANNOT_DEACTIVATE_SELF",
        message: "You cannot deactivate your own account.",
        metadata: { userId: ctx.actor.userId },
      });
    }

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, status: true },
    });
    if (target === null) {
      throw new errors.NotFoundError({
        code: "USER_NOT_FOUND",
        message: "User not found.",
        metadata: { targetUserId: input.targetUserId },
      });
    }

    const nextStatus = input.status === "TERMINATED" ? UserStatus.TERMINATED : UserStatus.SUSPENDED;

    await tx.user.update({
      where: { id: input.targetUserId },
      data: { status: nextStatus },
    });

    const revoked = await revokeAllUserSessionsInTx({
      tx,
      userId: input.targetUserId,
      reason: "USER_TERMINATED",
    });

    return {
      output: Object.freeze({
        targetUserId: input.targetUserId,
        status: nextStatus,
        sessionsRevoked: revoked,
      }),
      audit: {
        action: "user.deactivated",
        resourceType: "User",
        resourceId: input.targetUserId,
        metadata: {
          targetUserId: input.targetUserId,
          status: nextStatus,
          sessionsRevoked: revoked,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "user.deactivated.v1",
          aggregateType: "User",
          aggregateId: input.targetUserId,
          payload: {
            organizationId: ctx.organizationId,
            targetUserId: input.targetUserId,
            status: nextStatus,
            sessionsRevoked: revoked,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
