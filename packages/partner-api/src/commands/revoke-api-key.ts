// RevokeApiKey — cut off a partner API key (ADR-0032).
//
// Terminal: a revoked key cannot be re-activated (mint a new one).
// The row is retained for audit — `revokedAt` + `revokedReason` +
// the audit_log entry answer "when was the leaked key cut off, by
// whom, and why".
//
// Permission: `api.keys.manage` (ORGANIZATION scope).
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const REVOKE_API_KEY_NOT_FOUND = "REVOKE_API_KEY_NOT_FOUND";
export const REVOKE_API_KEY_ALREADY_REVOKED = "REVOKE_API_KEY_ALREADY_REVOKED";

const inputSchema = z
  .object({
    apiKeyId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type RevokeApiKeyInput = z.infer<typeof inputSchema>;

export interface RevokeApiKeyOutput {
  readonly apiKeyId: string;
  readonly tokenPrefix: string;
  readonly revokedAt: string;
}

export const RevokeApiKey: Command<RevokeApiKeyInput, RevokeApiKeyOutput> = {
  name: "RevokeApiKey",
  inputSchema,
  permission: PERMISSIONS.API_KEYS_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<RevokeApiKeyOutput>> {
    // Tenancy-scoped read: the auto-filter + RLS guarantee an
    // operator can only revoke keys in their own org.
    const existing = await tx.apiKey.findUnique({
      where: { id: input.apiKeyId },
      select: { id: true, status: true, tokenPrefix: true },
    });
    if (existing === null) {
      throw new errors.NotFoundError({
        code: REVOKE_API_KEY_NOT_FOUND,
        message: "API key not found.",
        metadata: { apiKeyId: input.apiKeyId },
      });
    }
    if (existing.status === "REVOKED") {
      throw new errors.ConflictError({
        code: REVOKE_API_KEY_ALREADY_REVOKED,
        message: "API key is already revoked.",
        metadata: { apiKeyId: input.apiKeyId },
      });
    }

    // Injected clock, not `new Date()`: the row, the command output,
    // and the outbox `occurredAt` must all be the SAME instant, and a
    // test has to be able to pin it.
    const revokedAt = clock.now();
    await tx.apiKey.update({
      where: { id: input.apiKeyId },
      data: {
        status: "REVOKED",
        revokedAt,
        revokedReason: input.reason,
      },
      select: { id: true },
    });

    return {
      output: Object.freeze({
        apiKeyId: input.apiKeyId,
        tokenPrefix: existing.tokenPrefix,
        revokedAt: revokedAt.toISOString(),
      }),
      audit: {
        action: "platform.api_key.revoked",
        resourceType: "ApiKey",
        resourceId: input.apiKeyId,
        metadata: {
          tokenPrefix: existing.tokenPrefix,
          reason: input.reason,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "platform.api_key.revoked.v1",
          aggregateType: "ApiKey",
          aggregateId: input.apiKeyId,
          payload: {
            organizationId: ctx.organizationId,
            apiKeyId: input.apiKeyId,
            tokenPrefix: existing.tokenPrefix,
            reason: input.reason,
            revokedByUserId: ctx.actor.userId,
            occurredAt: revokedAt.toISOString(),
          },
        },
      ],
    };
  },
};
