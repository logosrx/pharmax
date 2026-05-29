// Pure mapping logic for inbound Resend delivery webhooks.
//
// Kept SEPARATE from the route so the event→projection mapping has
// focused unit tests with no svix / Prisma / Next machinery. The
// route owns signature verification + the idempotent ledger insert
// + the DB update; this module owns "given a parsed Resend event,
// what should the notification_delivery row become?"
//
// Resend event vocabulary (https://resend.com/docs/webhooks):
//   email.sent              — accepted by Resend (we already wrote
//                             SENT at transport time; treated as a
//                             no-status engagement touch here)
//   email.delivered         — landed in the recipient MTA
//   email.delivery_delayed  — transient deferral (non-terminal)
//   email.bounced           — hard/soft bounce (terminal failure)
//   email.complained        — spam complaint (terminal-ish)
//   email.opened            — engagement (no status change)
//   email.clicked           — engagement (no status change)
//
// Status monotonicity: lifecycle events set `status`; engagement
// events (opened/clicked/sent) do NOT. The route additionally
// drops events whose `created_at` is older-or-equal to the row's
// `lastEventAt` so out-of-order Svix deliveries can't regress the
// projection.
//
// PHI: the event carries operator email + subject only. We project
// the event type + a coarse bounce/complaint reason; never the
// body.

import type { NotificationDeliveryStatus } from "@pharmax/database";

/** Minimal shape we read off a Resend webhook event. */
export interface ResendWebhookEventPayload {
  readonly type?: string;
  readonly created_at?: string;
  readonly data?: {
    readonly email_id?: string;
    readonly reason?: string;
    readonly bounce?: { readonly type?: string; readonly message?: string };
  };
}

export interface ResendDeliveryUpdate {
  /** Resend `email_id` — the join key to notification_delivery. */
  readonly providerMessageId: string;
  /** Event type verbatim (e.g. "email.delivered"). */
  readonly lastEventType: string;
  /** Event wall-clock time, parsed from `created_at`. */
  readonly lastEventAt: Date;
  /** Set ONLY for lifecycle events; omitted for engagement events
   *  so the route leaves `status` untouched. */
  readonly status?: NotificationDeliveryStatus;
  /** Coarse failure reason for bounce/complaint. */
  readonly failureReason?: string;
}

export type MapResendEventResult =
  | { readonly ok: true; readonly update: ResendDeliveryUpdate }
  | { readonly ok: false; readonly reason: "no_email_id" | "unknown_type" | "bad_timestamp" };

const LIFECYCLE_STATUS: Readonly<Record<string, NotificationDeliveryStatus>> = Object.freeze({
  "email.delivered": "DELIVERED",
  "email.delivery_delayed": "DELIVERY_DELAYED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
});

const ENGAGEMENT_TYPES: ReadonlySet<string> = new Set([
  "email.sent",
  "email.opened",
  "email.clicked",
]);

/**
 * Map a parsed Resend event to a `notification_delivery` update.
 * Returns `{ ok: false }` for events we can't act on (missing
 * email_id, unknown type, unparseable timestamp) — the route
 * records those as NOOP and acks 200 so Resend stops retrying.
 */
export function mapResendEvent(event: ResendWebhookEventPayload): MapResendEventResult {
  const type = event.type;
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, reason: "unknown_type" };
  }
  const emailId = event.data?.email_id;
  if (typeof emailId !== "string" || emailId.length === 0) {
    return { ok: false, reason: "no_email_id" };
  }

  const lastEventAt = parseTimestamp(event.created_at);
  if (lastEventAt === null) {
    return { ok: false, reason: "bad_timestamp" };
  }

  const isLifecycle = type in LIFECYCLE_STATUS;
  const isEngagement = ENGAGEMENT_TYPES.has(type);
  if (!isLifecycle && !isEngagement) {
    return { ok: false, reason: "unknown_type" };
  }

  const failureReason =
    type === "email.bounced" || type === "email.complained"
      ? composeFailureReason(event)
      : undefined;

  return {
    ok: true,
    update: {
      providerMessageId: emailId,
      lastEventType: type,
      lastEventAt,
      ...(isLifecycle ? { status: LIFECYCLE_STATUS[type] } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
    },
  };
}

function parseTimestamp(raw: string | undefined): Date | null {
  if (typeof raw !== "string" || raw.length === 0) {
    // Resend always sends created_at; tolerate absence by anchoring
    // to "now" would break the monotonic guard, so we reject instead.
    return null;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function composeFailureReason(event: ResendWebhookEventPayload): string {
  const bounceType = event.data?.bounce?.type;
  const bounceMsg = event.data?.bounce?.message;
  const reason = event.data?.reason;
  const parts = [bounceType, bounceMsg ?? reason].filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  return parts.length > 0 ? parts.join(": ") : (event.type ?? "unknown");
}
