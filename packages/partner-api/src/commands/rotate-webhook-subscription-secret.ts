// RotateWebhookSubscriptionSecret — replace a subscription's HMAC
// signing secret in place (ADR-0032 follow-up; closes the
// "rotation = revoke + recreate" gap noted in the ADR consequences).
//
// Transport contract mirrors CreateWebhookSubscription: the NEW raw
// `pxw_` secret is generated at the transport layer, passed here as
// a REDACTED input field, stored only as a `@pharmax/crypto`
// ciphertext envelope (same AAD tuple — the recordId does not
// change), and returned by the transport exactly once.
//
// Cut-over semantics (single-secret v1): the delivery drain decrypts
// the secret AT ATTEMPT TIME, so every delivery attempt after this
// command commits — including retries of previously-failed rows — is
// signed with the NEW secret. Partners must install the new secret
// on their receiver BEFORE calling rotate, then treat verification
// failures signed with the old secret as expired. Dual-secret
// overlap windows are a possible future increment; not this one.
//
// Only ACTIVE subscriptions can be rotated — a DISABLED endpoint has
// no egress to re-key, and silently re-arming it via rotation would
// bypass the (audited) revoke decision.
//
// Permission: `webhooks.manage` (ORGANIZATION scope).
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { WEBHOOK_SECRET_PREFIX } from "../api-key/token.js";

export const ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND =
  "ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND";
export const ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED =
  "ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED";

const inputSchema = z
  .object({
    subscriptionId: z.uuid(),
    /** NEW raw `pxw_` signing secret. REDACTED from command_log. */
    secret: z
      .string()
      .regex(
        new RegExp(`^${WEBHOOK_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`),
        "secret must be a pxw_-prefixed 256-bit base64url value"
      ),
  })
  .strict();

export type RotateWebhookSubscriptionSecretInput = z.infer<typeof inputSchema>;

export interface RotateWebhookSubscriptionSecretOutput {
  readonly subscriptionId: string;
  readonly url: string;
  readonly rotatedAt: string;
}

export const RotateWebhookSubscriptionSecret: Command<
  RotateWebhookSubscriptionSecretInput,
  RotateWebhookSubscriptionSecretOutput
> = {
  name: "RotateWebhookSubscriptionSecret",
  inputSchema,
  permission: PERMISSIONS.WEBHOOKS_MANAGE,
  redactFields: ["secret"],
  // The transport regenerates the secret on every retry; excluding it
  // from the idempotency hash lets a retry under the same
  // Idempotency-Key replay instead of hash-mismatching.
  hashExcludeFields: ["secret"],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<RotateWebhookSubscriptionSecretOutput>> {
    const existing = await tx.webhookSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, status: true, url: true },
    });
    if (existing === null) {
      throw new errors.NotFoundError({
        code: ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND,
        message: "Webhook subscription not found.",
        metadata: { subscriptionId: input.subscriptionId },
      });
    }
    if (existing.status !== "ACTIVE") {
      throw new errors.ConflictError({
        code: ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED,
        message:
          "Cannot rotate the secret of a disabled subscription. Create a new subscription instead.",
        metadata: { subscriptionId: input.subscriptionId },
      });
    }

    // Same AAD tuple as creation — the record id is stable, so the
    // envelope stays bound to (tenant, table, column, record) and the
    // delivery drain's decrypt binding needs no versioning.
    const secretEnc = (await encryptField({
      plaintext: input.secret,
      binding: {
        tenantId: ctx.organizationId,
        table: "webhook_subscription",
        column: "secret",
        recordId: input.subscriptionId,
      },
    })) as unknown as Prisma.InputJsonValue;

    const rotatedAt = new Date();
    await tx.webhookSubscription.update({
      where: { id: input.subscriptionId },
      data: { secretEnc },
      select: { id: true },
    });

    return {
      output: Object.freeze({
        subscriptionId: input.subscriptionId,
        url: existing.url,
        rotatedAt: rotatedAt.toISOString(),
      }),
      audit: {
        action: "platform.webhook_subscription.secret_rotated",
        resourceType: "WebhookSubscription",
        resourceId: input.subscriptionId,
        metadata: {
          url: existing.url,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "platform.webhook_subscription.secret_rotated.v1",
          aggregateType: "WebhookSubscription",
          aggregateId: input.subscriptionId,
          payload: {
            organizationId: ctx.organizationId,
            subscriptionId: input.subscriptionId,
            url: existing.url,
            rotatedByUserId: ctx.actor.userId,
            occurredAt: rotatedAt.toISOString(),
          },
        },
      ],
    };
  },
};
