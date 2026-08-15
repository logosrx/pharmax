// RevokeWebhookSubscription — disable a partner endpoint (ADR-0032).
//
// Disabling stops egress IMMEDIATELY: fan-out consults subscription
// status at delivery-creation time, and the delivery drain
// DEAD-letters in-flight PENDING rows whose subscription is
// DISABLED (a tenant may be cutting off a compromised receiver).
// The row and its delivery ledger are retained for audit.
//
// Permission: `webhooks.manage` (ORGANIZATION scope).
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND = "REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND";
export const REVOKE_WEBHOOK_SUBSCRIPTION_ALREADY_DISABLED =
  "REVOKE_WEBHOOK_SUBSCRIPTION_ALREADY_DISABLED";

const inputSchema = z
  .object({
    subscriptionId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type RevokeWebhookSubscriptionInput = z.infer<typeof inputSchema>;

export interface RevokeWebhookSubscriptionOutput {
  readonly subscriptionId: string;
  readonly url: string;
  readonly disabledAt: string;
}

export const RevokeWebhookSubscription: Command<
  RevokeWebhookSubscriptionInput,
  RevokeWebhookSubscriptionOutput
> = {
  name: "RevokeWebhookSubscription",
  inputSchema,
  permission: PERMISSIONS.WEBHOOKS_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<RevokeWebhookSubscriptionOutput>> {
    const existing = await tx.webhookSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, status: true, url: true },
    });
    if (existing === null) {
      throw new errors.NotFoundError({
        code: REVOKE_WEBHOOK_SUBSCRIPTION_NOT_FOUND,
        message: "Webhook subscription not found.",
        metadata: { subscriptionId: input.subscriptionId },
      });
    }
    if (existing.status === "DISABLED") {
      throw new errors.ConflictError({
        code: REVOKE_WEBHOOK_SUBSCRIPTION_ALREADY_DISABLED,
        message: "Webhook subscription is already disabled.",
        metadata: { subscriptionId: input.subscriptionId },
      });
    }

    // Injected clock, not `new Date()`: the row, the command output,
    // and the outbox `occurredAt` must all be the SAME instant, and a
    // test has to be able to pin it.
    const disabledAt = clock.now();
    await tx.webhookSubscription.update({
      where: { id: input.subscriptionId },
      data: { status: "DISABLED", disabledAt },
      select: { id: true },
    });

    return {
      output: Object.freeze({
        subscriptionId: input.subscriptionId,
        url: existing.url,
        disabledAt: disabledAt.toISOString(),
      }),
      audit: {
        action: "platform.webhook_subscription.revoked",
        resourceType: "WebhookSubscription",
        resourceId: input.subscriptionId,
        metadata: {
          url: existing.url,
          reason: input.reason,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "platform.webhook_subscription.revoked.v1",
          aggregateType: "WebhookSubscription",
          aggregateId: input.subscriptionId,
          payload: {
            organizationId: ctx.organizationId,
            subscriptionId: input.subscriptionId,
            url: existing.url,
            reason: input.reason,
            revokedByUserId: ctx.actor.userId,
            occurredAt: disabledAt.toISOString(),
          },
        },
      ],
    };
  },
};
