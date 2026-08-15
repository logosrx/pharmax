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
// Endpoint validation: the URL is an instruction for our worker to
// make a request from inside the VPC, so it is screened for
// non-public destinations before it is stored. The guard is shared
// with @pharmax/shipping's carrier base URL — see
// platform-core net/outbound-url.ts for the threat model and for
// what DNS still leaves open.
//
// Permission: `webhooks.manage` (ORGANIZATION scope).
//
// PHI: none.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import { WebhookSubscriptionStatus, type Prisma } from "@pharmax/database";
import { errors, net } from "@pharmax/platform-core";
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
export const CREATE_WEBHOOK_SUBSCRIPTION_URL_UNPARSEABLE =
  "CREATE_WEBHOOK_SUBSCRIPTION_URL_UNPARSEABLE";
export const CREATE_WEBHOOK_SUBSCRIPTION_URL_HAS_CREDENTIALS =
  "CREATE_WEBHOOK_SUBSCRIPTION_URL_HAS_CREDENTIALS";
export const CREATE_WEBHOOK_SUBSCRIPTION_URL_NON_DEFAULT_PORT =
  "CREATE_WEBHOOK_SUBSCRIPTION_URL_NON_DEFAULT_PORT";
export const CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_PUBLIC =
  "CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_PUBLIC";
export const CREATE_WEBHOOK_SUBSCRIPTION_DUPLICATE_ENDPOINT =
  "CREATE_WEBHOOK_SUBSCRIPTION_DUPLICATE_ENDPOINT";

const inputSchema = z
  .object({
    /** Partner endpoint. Screened below with a typed error. */
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

/** One greppable command error code per endpoint-refusal cause. */
function rejectionCode(reason: net.OutboundUrlRejection): string {
  switch (reason) {
    case "unparseable":
      return CREATE_WEBHOOK_SUBSCRIPTION_URL_UNPARSEABLE;
    case "not_https":
      return CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS;
    case "embedded_credentials":
      return CREATE_WEBHOOK_SUBSCRIPTION_URL_HAS_CREDENTIALS;
    case "non_default_port":
      return CREATE_WEBHOOK_SUBSCRIPTION_URL_NON_DEFAULT_PORT;
    case "non_public_host":
      return CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_PUBLIC;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * The status this command puts a new subscription in. Written to the
 * row AND returned in the output from this one binding, so the two
 * cannot disagree.
 *
 * Previously the row relied on the `@default(ACTIVE)` in the Prisma
 * schema while the output hard-coded the literal. That is true today
 * but is a latent lie: changing the schema default would leave the
 * command reporting a state it did not create. Writing the column
 * explicitly also matches `RegisterCarrierCredential`, which has
 * always set `status` rather than leaning on the default.
 */
const CREATED_STATUS = WebhookSubscriptionStatus.ACTIVE;

export interface CreateWebhookSubscriptionOutput {
  readonly subscriptionId: string;
  readonly url: string;
  readonly eventTypes: ReadonlyArray<string>;
  readonly status: typeof CREATED_STATUS;
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
    const endpoint = net.classifyOutboundUrl(input.url);
    if (!endpoint.ok) {
      throw new errors.ValidationError({
        code: rejectionCode(endpoint.reason),
        message: `Webhook endpoint refused. ${endpoint.detail}`,
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

    // Every ACTIVE subscription on a URL receives every matching
    // event, so a second registration of the same endpoint doubles
    // the partner's traffic and their signature-verification load
    // with no way to tell the copies apart. Scoped to ACTIVE because
    // RevokeWebhookSubscription retains the DISABLED row for audit
    // and re-registering a revoked endpoint is legitimate.
    //
    // Advisory, not atomic: `webhook_subscription` has no unique
    // constraint on (organizationId, url), so two concurrent creates
    // can still both pass. The bus's idempotency key covers the
    // realistic case (a retried submit); the constraint that would
    // make this airtight is tracked as a follow-up.
    const duplicate = await tx.webhookSubscription.findFirst({
      where: { organizationId: ctx.organizationId, url: input.url, status: "ACTIVE" },
      select: { id: true },
    });
    if (duplicate !== null) {
      throw new errors.ConflictError({
        code: CREATE_WEBHOOK_SUBSCRIPTION_DUPLICATE_ENDPOINT,
        message: "An active webhook subscription already exists for this endpoint.",
        metadata: { existingSubscriptionId: duplicate.id },
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
        status: CREATED_STATUS,
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
        status: CREATED_STATUS,
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
