// CreateWebhookSubscription — register a partner endpoint for
// outbound event delivery (ADR-0032).
//
// The raw `pxw_` signing secret is generated at the transport layer
// and passed here as a REDACTED input field; it is stored only as a
// `@pharmax/crypto` ciphertext envelope bound to (tenant, table,
// column, recordId). The command output never echoes the secret —
// the transport layer returns the value it generated, exactly once.
//
// Event-type validation: every subscribed type must be a registered
// event with `phiSafe: true` (derived set — see eligible-events.ts).
// A phi-bearing event type cannot be subscribed by construction.
//
// Permission: `webhooks.manage` (ORGANIZATION scope).
//
// PHI: none.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  isWebhookEligibleEventType,
  listWebhookEligibleEventTypes,
} from "../webhooks/eligible-events.js";
import { WEBHOOK_SECRET_PREFIX } from "../api-key/token.js";

export const CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT =
  "CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT";
export const CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS =
  "CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS";

const inputSchema = z
  .object({
    /** Partner endpoint. HTTPS-only (checked below with a typed error). */
    url: z.url().max(2000),
    /** Versioned registry event names. phi-safe only. */
    eventTypes: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    description: z.string().trim().max(500).optional(),
    /** Raw `pxw_` signing secret. REDACTED from command_log. */
    secret: z
      .string()
      .regex(
        new RegExp(`^${WEBHOOK_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`),
        "secret must be a pxw_-prefixed 256-bit base64url value"
      ),
  })
  .strict();

export type CreateWebhookSubscriptionInput = z.infer<typeof inputSchema>;

export interface CreateWebhookSubscriptionOutput {
  readonly subscriptionId: string;
  readonly url: string;
  readonly eventTypes: ReadonlyArray<string>;
  readonly status: "ACTIVE";
}

export const CreateWebhookSubscription: Command<
  CreateWebhookSubscriptionInput,
  CreateWebhookSubscriptionOutput
> = {
  name: "CreateWebhookSubscription",
  inputSchema,
  permission: PERMISSIONS.WEBHOOKS_MANAGE,
  redactFields: ["secret"],
  // The transport layer regenerates the signing secret on EVERY
  // attempt. Excluding it from the idempotency request hash lets a
  // partner retry under the same Idempotency-Key replay the stored
  // subscription instead of 409ing on a payload mismatch. The
  // client-controlled fields (url, eventTypes, description) still
  // participate fully.
  hashExcludeFields: ["secret"],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<CreateWebhookSubscriptionOutput>> {
    if (!input.url.startsWith("https://")) {
      throw new errors.ValidationError({
        code: CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS,
        message: "Webhook endpoints must be HTTPS.",
      });
    }

    const eventTypes = [...new Set(input.eventTypes)];
    const ineligible = eventTypes.filter((t) => !isWebhookEligibleEventType(t));
    if (ineligible.length > 0) {
      throw new errors.ValidationError({
        code: CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT,
        message: `Event type(s) not subscribable: ${ineligible.join(", ")}. Subscribable types are registered phi-safe events.`,
        metadata: { ineligible, eligible: listWebhookEligibleEventTypes() },
      });
    }

    // Generate the id up front so the ciphertext envelope's AAD can
    // bind to the record (same pattern as RegisterCarrierCredential).
    const subscriptionId = randomUUID();
    const secretEnc = (await encryptField({
      plaintext: input.secret,
      binding: {
        tenantId: ctx.organizationId,
        table: "webhook_subscription",
        column: "secret",
        recordId: subscriptionId,
      },
    })) as unknown as Prisma.InputJsonValue;

    await tx.webhookSubscription.create({
      data: {
        id: subscriptionId,
        organizationId: ctx.organizationId,
        url: input.url,
        secretEnc,
        eventTypes,
        description: input.description ?? null,
        createdByUserId: ctx.actor.userId,
        createCommandLogId: commandLogId,
      },
      select: { id: true },
    });

    const occurredAt = new Date().toISOString();
    return {
      output: Object.freeze({
        subscriptionId,
        url: input.url,
        eventTypes: Object.freeze(eventTypes),
        status: "ACTIVE" as const,
      }),
      audit: {
        action: "platform.webhook_subscription.created",
        resourceType: "WebhookSubscription",
        resourceId: subscriptionId,
        metadata: {
          url: input.url,
          eventTypes,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "platform.webhook_subscription.created.v1",
          aggregateType: "WebhookSubscription",
          aggregateId: subscriptionId,
          payload: {
            organizationId: ctx.organizationId,
            subscriptionId,
            url: input.url,
            eventTypes,
            createdByUserId: ctx.actor.userId,
            occurredAt,
          },
        },
      ],
    };
  },
};
