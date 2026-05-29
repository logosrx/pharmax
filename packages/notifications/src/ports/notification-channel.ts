// NotificationChannel — the cross-cutting "tell a human something"
// port.
//
// The platform predictably needs to send:
//
//   - invoice payment-failure alerts to billing operators
//   - hold-expiry reminders to the team that owns an order
//   - shipment-escalation alerts to operations leads
//   - workflow-rejection notices to typing / fill teams
//
// Each of those triggers from a domain event that already exists
// in the codebase. The CHANNEL doesn't care which event triggered
// it — it accepts a typed template id from the registry, a
// recipient, a context payload, and an idempotency key. The
// adapter behind the port decides HOW to deliver (Resend for
// email, Twilio for SMS, the `notification_in_app` table for
// in-app), and the channel is the only place that knows that
// detail.
//
// PHI safety is STRUCTURAL: this port refuses any `context` value
// whose top-level keys match the registry's PHI sentinel list
// unless the template AND the channel are both PHI-flagged. A
// future adapter that hooks up to a non-PHI-eligible transport
// (e.g. an off-the-shelf marketing-email SaaS) is configured with
// `phiCapable: false` and CANNOT send a PHI-flagged template even
// by accident — the runtime gate fires before any bytes leave the
// process.
//
// Idempotency: every send carries an `idempotencyKey`. The adapter
// is responsible for deduplicating retries at that key. Two sends
// with the same key resolve to the same delivery (no double email,
// no double SMS, no double in-app row).

import { errors } from "@pharmax/platform-core";

import {
  PHI_SENTINEL_EXACT_KEYS,
  PHI_SENTINEL_PREFIX_KEYS,
  type NotificationRecipientKind,
  type NotificationTemplateDefinition,
  type NotificationTemplateId,
} from "../templates/template-registry.js";

/** Recipient address. The `kind` MUST be one the registry's
 *  template lists in its `channelKinds`. */
export interface NotificationRecipient {
  readonly kind: NotificationRecipientKind;
  /** Email address, phone number, or in-app userId — the format
   *  is determined by `kind`. */
  readonly address: string;
}

/** Shape every channel adapter accepts. */
export interface NotificationSendInput {
  readonly to: NotificationRecipient;
  readonly template: NotificationTemplateId;
  /** Template substitution variables. Top-level keys are validated
   *  against the registry's PHI sentinel list — see header. */
  readonly context: Readonly<Record<string, unknown>>;
  /** Stable key the adapter uses to dedupe retries. The handler
   *  that triggers the send is responsible for choosing a key that
   *  uniquely identifies "this delivery" (e.g. event id, command
   *  id + recipient). */
  readonly idempotencyKey: string;
  /** Optional trace identifier propagated into logs / dashboards. */
  readonly correlationId?: string;
  /**
   * Optional owning organization. Pure transport channels ignore
   * this; the `PersistentNotificationChannel` decorator uses it to
   * write the tenant-scoped `notification_delivery` ledger row.
   * When absent, the decorator skips persistence (degrades to a
   * plain transport send) — so a caller that hasn't wired org
   * context still delivers, it just isn't tracked.
   */
  readonly organizationId?: string;
}

/** Outcome of a send attempt. */
export interface NotificationSendResult {
  /** Adapter-assigned id for the delivery (uuid or vendor-side
   *  message id). */
  readonly deliveryId: string;
  /** `delivered` for happy path; `deduplicated` when an earlier
   *  send with the same `idempotencyKey` already won; `queued` when
   *  the adapter accepted but hasn't yet handed the bytes to the
   *  vendor (e.g. a batching adapter). */
  readonly status: "delivered" | "deduplicated" | "queued";
  /** Echo of the input recipient kind for convenience. */
  readonly recipientKind: NotificationRecipientKind;
  /** Adapter-side delivery timestamp. */
  readonly sentAt: Date;
}

/**
 * The port. One implementation per environment:
 *
 *   - `InMemoryNotificationChannel` for tests + ephemeral dev. No
 *     network, no vendor SDK; records every send for assertion.
 *   - (future) `ResendEmailChannel`, `TwilioSmsChannel`,
 *     `DatabaseInAppChannel` — each wires its vendor to this
 *     contract. Production composition runs them behind a router
 *     that picks the right adapter for `to.kind`.
 *
 * The interface intentionally has a SINGLE method. Multi-recipient
 * fan-out belongs ABOVE the channel (caller loops, or a router
 * adapter forwards one input per recipient).
 */
export interface NotificationChannel {
  /** Returns metadata about the channel for caller-side routing. */
  readonly metadata: NotificationChannelMetadata;

  send(input: NotificationSendInput): Promise<NotificationSendResult>;
}

/** Static descriptor the channel publishes. */
export interface NotificationChannelMetadata {
  /** Human-friendly name for logs and dashboards. */
  readonly name: string;
  /** Recipient kinds this channel can deliver to. The runtime
   *  guard `assertChannelSupportsRecipient` fires when a send
   *  targets a kind not in this list. */
  readonly supportedRecipientKinds: ReadonlyArray<NotificationRecipientKind>;
  /** When `true`, the channel may carry PHI-flagged templates
   *  (transport is HIPAA-eligible, BAA in place, etc.). Defaults
   *  to `false` for every channel. */
  readonly phiCapable: boolean;
}

// ---------------------------------------------------------------------------
// Error codes the port + every adapter MAY throw.
// ---------------------------------------------------------------------------

/** The channel cannot deliver to the requested recipient kind. */
export const NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED =
  "NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED" as const;

/** The template doesn't list this recipient kind among its
 *  `channelKinds`. */
export const NOTIFICATION_TEMPLATE_RECIPIENT_MISMATCH =
  "NOTIFICATION_TEMPLATE_RECIPIENT_MISMATCH" as const;

/** A top-level key in `context` looks like PHI and the template
 *  is not PHI-allowed (or the channel is not PHI-capable). */
export const NOTIFICATION_PHI_REJECTED = "NOTIFICATION_PHI_REJECTED" as const;

/** A required template variable is missing from `context`. */
export const NOTIFICATION_CONTEXT_MISSING_KEY = "NOTIFICATION_CONTEXT_MISSING_KEY" as const;

/** The adapter was wired but a downstream transport failed. */
export const NOTIFICATION_TRANSPORT_ERROR = "NOTIFICATION_TRANSPORT_ERROR" as const;

// ---------------------------------------------------------------------------
// Shared guards every adapter is expected to run at the top of
// `send`. Centralised here so a "new transport, day-one" adapter
// can't forget a check by copy-pasting from an old one.
// ---------------------------------------------------------------------------

/**
 * Asserts the channel's `supportedRecipientKinds` covers the
 * recipient. The check is symmetric with the template/recipient
 * mismatch check below — both must pass before the adapter touches
 * the vendor.
 */
export function assertChannelSupportsRecipient(
  metadata: NotificationChannelMetadata,
  recipient: NotificationRecipient
): void {
  if (!metadata.supportedRecipientKinds.includes(recipient.kind)) {
    throw new errors.ValidationError({
      code: NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED,
      message: `Channel "${metadata.name}" does not support recipient kind "${recipient.kind}".`,
      issues: [{ path: ["to", "kind"], message: "unsupported by channel" }],
      metadata: {
        channelName: metadata.name,
        recipientKind: recipient.kind,
        supported: metadata.supportedRecipientKinds.slice(),
      },
    });
  }
}

/**
 * Asserts the template lists the recipient's kind. Pairs with
 * `assertChannelSupportsRecipient`: that one checks the channel's
 * physical capability, this one checks the editorial choice
 * recorded in the registry ("this template is only meaningful as
 * an email").
 */
export function assertTemplateAllowsRecipient(
  template: NotificationTemplateDefinition,
  recipient: NotificationRecipient
): void {
  if (!template.channelKinds.includes(recipient.kind)) {
    throw new errors.ValidationError({
      code: NOTIFICATION_TEMPLATE_RECIPIENT_MISMATCH,
      message: `Template "${template.id}" does not list "${recipient.kind}" in its channelKinds.`,
      issues: [{ path: ["template"], message: "template/recipient mismatch" }],
      metadata: {
        templateId: template.id,
        recipientKind: recipient.kind,
        allowed: template.channelKinds.slice(),
      },
    });
  }
}

/**
 * Asserts every required context key is present (own enumerable
 * property, not undefined). Channels that allow extra keys are
 * fine; channels that want to enforce no-extras must do that on
 * top of this check.
 */
export function assertRequiredContextKeysPresent(
  template: NotificationTemplateDefinition,
  context: Readonly<Record<string, unknown>>
): void {
  for (const key of template.requiredContextKeys) {
    if (!Object.prototype.hasOwnProperty.call(context, key) || context[key] === undefined) {
      throw new errors.ValidationError({
        code: NOTIFICATION_CONTEXT_MISSING_KEY,
        message: `Template "${template.id}" requires context key "${key}".`,
        issues: [{ path: ["context", key], message: "required by template" }],
        metadata: {
          templateId: template.id,
          missingKey: key,
        },
      });
    }
  }
}

/**
 * PHI gate. Walks the top-level keys of `context` against the
 * registry's sentinel list. Throws if (a) any key matches AND
 * (b) the template is not flagged `phiAllowed` OR the channel is
 * not flagged `phiCapable`.
 *
 * **Why top-level only:** the check is intentionally narrow — it
 * catches the common-case "I forgot to scrub the patient record
 * before handing it to the template" mistake. Deep DLP (regex over
 * stringified leaves, SSN-shape detection, etc.) belongs in a
 * downstream proxy if we ever need it; this layer is a structural
 * safety, not a content classifier.
 *
 * The metadata reports the OFFENDING KEY NAME ONLY — never the
 * value. PHI must never appear in the resulting error envelope.
 */
export function assertNoPhiInContext(
  template: NotificationTemplateDefinition,
  channel: NotificationChannelMetadata,
  context: Readonly<Record<string, unknown>>
): void {
  // Both gates must be open for PHI to be allowed through.
  if (template.phiAllowed && channel.phiCapable) {
    return;
  }

  for (const rawKey of Object.keys(context)) {
    const lower = rawKey.toLowerCase();
    const matchedExact = PHI_SENTINEL_EXACT_KEYS.includes(lower);
    const matchedPrefix = matchedExact
      ? false
      : PHI_SENTINEL_PREFIX_KEYS.some((prefix) => lower.startsWith(prefix));
    if (matchedExact || matchedPrefix) {
      const reason = templatePhiRejectionReason(template, channel);
      throw new errors.AuthorizationError({
        code: NOTIFICATION_PHI_REJECTED,
        message: `Notification context key "${rawKey}" matched the PHI sentinel list (${reason}).`,
        metadata: {
          templateId: template.id,
          channelName: channel.name,
          offendingKey: rawKey,
          templatePhiAllowed: template.phiAllowed,
          channelPhiCapable: channel.phiCapable,
        },
      });
    }
  }
}

function templatePhiRejectionReason(
  template: NotificationTemplateDefinition,
  channel: NotificationChannelMetadata
): string {
  if (!template.phiAllowed && !channel.phiCapable) {
    return "template is not phiAllowed and channel is not phiCapable";
  }
  if (!template.phiAllowed) {
    return "template is not phiAllowed";
  }
  return "channel is not phiCapable";
}
