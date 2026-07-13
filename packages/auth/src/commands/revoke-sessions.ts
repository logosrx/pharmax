// RevokeSessions — self-service "log out everywhere" (or everywhere-else).
//
// Revokes the actor's own active sessions. `scope: "others"` keeps the
// current session (identified by `exceptSessionId`) and drops the rest;
// `scope: "all"` drops everything (full sign-out on all devices).
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

const inputSchema = z
  .object({
    scope: z.enum(["all", "others"]).default("others"),
    /** Required when scope is "others": the session to keep alive. */
    exceptSessionId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.scope === "all" || v.exceptSessionId !== undefined, {
    message: "exceptSessionId is required when scope is 'others'",
    path: ["exceptSessionId"],
  });

export type RevokeSessionsInput = z.infer<typeof inputSchema>;

export interface RevokeSessionsOutput {
  readonly userId: string;
  readonly revoked: number;
}

export const RevokeSessions: Command<RevokeSessionsInput, RevokeSessionsOutput> = {
  name: "RevokeSessions",
  inputSchema,
  permission: null,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RevokeSessionsOutput>> {
    const userId = ctx.actor.userId;
    const now = clock.now();

    const revoked = await tx.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(input.scope === "others" && input.exceptSessionId !== undefined
          ? { id: { not: input.exceptSessionId } }
          : {}),
      },
      data: { revokedAt: now, revokedReason: "USER_LOGOUT" },
    });

    return {
      output: Object.freeze({ userId, revoked: revoked.count }),
      audit: {
        action: "user.sessions_revoked",
        resourceType: "User",
        resourceId: userId,
        metadata: { userId, scope: input.scope, revoked: revoked.count, commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.sessions_revoked.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            organizationId: ctx.organizationId,
            userId,
            scope: input.scope,
            revoked: revoked.count,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
