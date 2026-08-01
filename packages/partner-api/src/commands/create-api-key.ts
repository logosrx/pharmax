// CreateApiKey — mint a partner API key (ADR-0032).
//
// The RAW token never enters this command: the transport layer
// generates it, returns it to the operator exactly once, and passes
// only the SHA-256 hash + display prefix here. That keeps the secret
// out of `command_log` and out of the idempotency response cache by
// construction (not by redaction).
//
// Scope validation is two-layered like CreateRole: the typed
// registry first (typos), then nothing else — scopes are permission
// CODES, not FK targets, so no seed-drift check is needed.
//
// Permission: `api.keys.manage` (ORGANIZATION scope).
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ApiKeyQuotaTier, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { isPermissionCode, PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const CREATE_API_KEY_UNKNOWN_SCOPE = "CREATE_API_KEY_UNKNOWN_SCOPE";
export const CREATE_API_KEY_HASH_COLLISION = "CREATE_API_KEY_HASH_COLLISION";

const inputSchema = z
  .object({
    /** Operator-facing label ("Acme telehealth prod"). */
    name: z.string().trim().min(1).max(120),
    /** SHA-256 hex of the raw token (generated at the transport layer). */
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "tokenHash must be a lowercase SHA-256 hex digest"),
    /** Display prefix (e.g. `pxk_3fA9`). Not secret. */
    tokenPrefix: z.string().min(4).max(16),
    /** Permission codes the key may exercise. MUST be non-empty. */
    scopes: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
    /**
     * Named quota tier (ADR-0032). Defaults to STANDARD; ELEVATED is
     * granted per partner agreement. The tier's numbers live in
     * `api-key/quota.ts`, not on the row.
     */
    quotaTier: z.enum(ApiKeyQuotaTier).default(ApiKeyQuotaTier.STANDARD),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof inputSchema>;

export interface CreateApiKeyOutput {
  readonly apiKeyId: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: ReadonlyArray<string>;
  readonly quotaTier: ApiKeyQuotaTier;
}

export const CreateApiKey: Command<CreateApiKeyInput, CreateApiKeyOutput> = {
  name: "CreateApiKey",
  inputSchema,
  permission: PERMISSIONS.API_KEYS_MANAGE,
  // The hash is not reversible, but there is no reason for it to
  // sit in command_log either — redact it.
  redactFields: ["tokenHash"],
  // The transport layer regenerates the raw token (and therefore
  // tokenHash + tokenPrefix) on EVERY attempt. If these fields
  // entered the idempotency request hash, an honest client retry
  // under the same Idempotency-Key would hash differently and be
  // rejected as a payload mismatch instead of replaying. Only the
  // client-controlled fields (name, scopes) participate.
  hashExcludeFields: ["tokenHash", "tokenPrefix"],

  async handle({ input, ctx, tx, commandLogId }): Promise<HandlerResult<CreateApiKeyOutput>> {
    const scopes = [...new Set(input.scopes)];
    const unknown = scopes.filter((s) => !isPermissionCode(s));
    if (unknown.length > 0) {
      throw new errors.ValidationError({
        code: CREATE_API_KEY_UNKNOWN_SCOPE,
        message: `Unrecognized scope code(s): ${unknown.join(", ")}.`,
        metadata: { unknown },
      });
    }

    let apiKeyId: string;
    try {
      const created = await tx.apiKey.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          tokenHash: input.tokenHash,
          tokenPrefix: input.tokenPrefix,
          scopes,
          quotaTier: input.quotaTier,
          createdByUserId: ctx.actor.userId,
          createCommandLogId: commandLogId,
        },
        select: { id: true },
      });
      apiKeyId = created.id;
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        // 256-bit collision is not a thing; a duplicate hash means a
        // duplicate RAW token, i.e. a transport-layer bug.
        throw new errors.ConflictError({
          code: CREATE_API_KEY_HASH_COLLISION,
          message: "A key with this token hash already exists.",
          cause,
        });
      }
      throw cause;
    }

    return {
      output: Object.freeze({
        apiKeyId,
        name: input.name,
        tokenPrefix: input.tokenPrefix,
        scopes: Object.freeze(scopes),
        quotaTier: input.quotaTier,
      }),
      audit: {
        action: "platform.api_key.created",
        resourceType: "ApiKey",
        resourceId: apiKeyId,
        metadata: {
          name: input.name,
          tokenPrefix: input.tokenPrefix,
          scopes,
          quotaTier: input.quotaTier,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "platform.api_key.created.v1",
          aggregateType: "ApiKey",
          aggregateId: apiKeyId,
          payload: {
            organizationId: ctx.organizationId,
            apiKeyId,
            name: input.name,
            tokenPrefix: input.tokenPrefix,
            scopes,
            quotaTier: input.quotaTier,
            createdByUserId: ctx.actor.userId,
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};
