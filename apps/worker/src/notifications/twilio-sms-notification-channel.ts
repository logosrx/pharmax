// TwilioSmsNotificationChannel — production SMS adapter.
//
// Implements `NotificationChannel` against Twilio's Programmable
// Messaging REST API (`POST /2010-04-01/Accounts/{Sid}/Messages.json`).
// Routes only `to.kind === "sms"`; any other recipient kind surfaces
// as `NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED` at the standard guard.
//
// Sender selection: we send with a **Messaging Service SID**, not a
// raw `From` number. Per Twilio's guidance, supplying
// `MessagingServiceSid` lets the Sender Pool pick the optimal sender
// (sticky sender, geo-match, compliant number per destination) and
// the message's initial status is `accepted`. This is the
// production-correct sender model — a hard-coded `From` would break
// the moment ops adds a second number or a toll-free/short-code lane.
//
// Idempotency: UNLIKE Resend, Twilio's Messages API has NO
// server-side idempotency header — re-POSTing the same body sends a
// SECOND text. This adapter therefore does NOT attempt vendor-side
// dedupe. Dedupe is the job of the `PersistentNotificationChannel`
// decorator, which records a `notification_delivery` row keyed by
// `(organizationId, idempotencyKey)` BEFORE the transport send. The
// outbox drainer's at-least-once delivery is reconciled there, not
// here. We still thread `idempotencyKey` through for the delivery
// ledger and logs.
//
// Transport failures: a non-2xx from Twilio (parsed `{ code, message }`
// envelope) or an unhandled `fetch` error is translated to a
// `PharmaxError` with code `NOTIFICATION_TRANSPORT_ERROR`. The outbox
// drainer catches and reschedules with exponential backoff. The
// underlying error is preserved via `cause` for Sentry, and the
// Twilio error code (e.g. 21610 recipient unsubscribed / STOP, 30127
// invalid Messaging Service SID) is projected into metadata — never
// the message body.
//
// PHI invariant: SMS is NOT a PHI-eligible transport in our current
// posture (no signed BAA covering Twilio Messaging, and SMS traverses
// carrier networks Twilio cannot cover under a BAA). The channel
// reports `phiCapable: false`; the registry's `assertNoPhiInContext`
// gate rejects any context payload whose top-level keys match the PHI
// sentinel list. To send PHI by text in the future you'd need a BAA
// review AND a deliberate flip of both this flag and the template's
// `phiAllowed` — most likely we'd route PHI-bearing patient messages
// to a secure in-app/portal channel instead.

import { errors } from "@pharmax/platform-core";
import {
  assertChannelSupportsRecipient,
  assertNoPhiInContext,
  assertRequiredContextKeysPresent,
  assertTemplateAllowsRecipient,
  getTemplate,
  NOTIFICATION_TRANSPORT_ERROR,
  type NotificationChannel,
  type NotificationChannelMetadata,
  type NotificationRecipientKind,
  type NotificationSendInput,
  type NotificationSendResult,
} from "@pharmax/notifications";

/**
 * Narrow contract over Twilio's `Messages.create` for testing — the
 * adapter calls only this slice, so unit tests pass a stub that
 * implements the same shape without standing up the SDK or `fetch`.
 */
export interface TwilioMessagesApi {
  create(input: {
    readonly to: string;
    readonly messagingServiceSid: string;
    readonly body: string;
  }): Promise<TwilioMessageResult>;
}

/** The fields we read off a Twilio Message resource. */
export interface TwilioMessageResult {
  /** `SMxxxxxxxx…` message SID — our `deliveryId`. */
  readonly sid: string;
  /** queued | accepted | sending | sent | delivered | undelivered | failed */
  readonly status: string;
  /** Populated by Twilio on a delivery problem; null on the happy path. */
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
}

export interface TwilioSmsNotificationChannelOptions {
  /** Twilio Account SID (`AC…`). Used for Basic-auth + the REST path. */
  readonly accountSid: string;
  /** Twilio Auth Token (or an API-key secret paired with an API-key
   *  SID — see `authSid`). Basic-auth password. */
  readonly authToken: string;
  /** Optional API-key SID (`SK…`) to use as the Basic-auth username
   *  instead of `accountSid`. Production SHOULD prefer a scoped API
   *  key over the account auth token. */
  readonly authSid?: string;
  /** Messaging Service SID (`MG…`). REQUIRED — we never send with a
   *  raw `From`. */
  readonly messagingServiceSid: string;
  /** Override the transport (tests). Production leaves this undefined
   *  and we construct a `fetch`-based client. */
  readonly messagesApi?: TwilioMessagesApi;
  /** Channel name reported in metadata + error envelopes. */
  readonly name?: string;
  /** Override the REST base (tests / non-default regions). */
  readonly apiBaseUrl?: string;
}

const DEFAULT_NAME = "twilio-sms";
const DEFAULT_API_BASE = "https://api.twilio.com";
const SUPPORTED_KINDS: ReadonlyArray<NotificationRecipientKind> = Object.freeze(["sms"]);

/** Twilio statuses that mean "the carrier rejected/failed it" — we
 *  surface these as transport errors so the outbox retries. */
const TWILIO_FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "undelivered"]);

/** Twilio statuses that mean "delivered to the handset". */
const TWILIO_DELIVERED_STATUSES: ReadonlySet<string> = new Set(["sent", "delivered"]);

export class TwilioSmsNotificationChannel implements NotificationChannel {
  public readonly metadata: NotificationChannelMetadata;

  private readonly api: TwilioMessagesApi;
  private readonly messagingServiceSid: string;

  constructor(options: TwilioSmsNotificationChannelOptions) {
    this.metadata = Object.freeze({
      name: options.name ?? DEFAULT_NAME,
      supportedRecipientKinds: SUPPORTED_KINDS,
      // SMS is not PHI-eligible in our posture. See file header.
      phiCapable: false,
    });
    this.messagingServiceSid = options.messagingServiceSid;
    this.api = options.messagesApi ?? buildDefaultMessagesApi(options);
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    // Validation gates run first — identical order to every other
    // channel so a copy-paste adapter can't skip one.
    const template = getTemplate(input.template);
    assertChannelSupportsRecipient(this.metadata, input.to);
    assertTemplateAllowsRecipient(template, input.to);
    assertRequiredContextKeysPresent(template, input.context);
    assertNoPhiInContext(template, this.metadata, input.context);

    const body = renderSmsBody(input.template, input.context);

    let result: TwilioMessageResult;
    try {
      result = await this.api.create({
        to: input.to.address,
        messagingServiceSid: this.messagingServiceSid,
        body,
      });
    } catch (cause) {
      throw new errors.InternalError({
        code: NOTIFICATION_TRANSPORT_ERROR,
        message: "Twilio transport failed before a response was returned.",
        metadata: { channelName: this.metadata.name, template: input.template },
        cause,
      });
    }

    // A populated errorCode (or a failed/undelivered status) means the
    // carrier won't deliver this — treat as a transport error so the
    // outbox reschedules. We log the Twilio code, NEVER the body.
    if (result.errorCode !== null || TWILIO_FAILED_STATUSES.has(result.status)) {
      throw new errors.InternalError({
        code: NOTIFICATION_TRANSPORT_ERROR,
        message: `Twilio reported a delivery failure (status="${result.status}").`,
        metadata: {
          channelName: this.metadata.name,
          template: input.template,
          twilioStatus: result.status,
          twilioErrorCode: result.errorCode,
          twilioMessageSid: result.sid,
        },
      });
    }

    return Object.freeze({
      deliveryId: result.sid,
      // `sent`/`delivered` → delivered; `queued`/`accepted`/`sending`
      // → queued (the Messaging Service has accepted it but hasn't
      // confirmed handset delivery — a status-callback webhook would
      // promote it later, a future slice).
      status: TWILIO_DELIVERED_STATUSES.has(result.status)
        ? ("delivered" as const)
        : ("queued" as const),
      recipientKind: input.to.kind,
      sentAt: new Date(),
    });
  }
}

/**
 * Build a `fetch`-based client against the Twilio Messages REST
 * endpoint. We deliberately avoid the `twilio` SDK here: the call is
 * a single form-encoded POST, and staying SDK-free keeps the worker's
 * dependency surface (and cold-start) small. The seam above means
 * tests never touch the network.
 */
function buildDefaultMessagesApi(options: TwilioSmsNotificationChannelOptions): TwilioMessagesApi {
  const base = options.apiBaseUrl ?? DEFAULT_API_BASE;
  const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  const basicUser = options.authSid ?? options.accountSid;
  const authHeader = `Basic ${Buffer.from(`${basicUser}:${options.authToken}`).toString("base64")}`;

  return {
    async create(input) {
      const form = new URLSearchParams({
        To: input.to,
        MessagingServiceSid: input.messagingServiceSid,
        Body: input.body,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });

      const payload = (await response.json().catch(() => null)) as {
        sid?: string;
        status?: string;
        error_code?: number | null;
        error_message?: string | null;
        code?: number;
        message?: string;
      } | null;

      if (!response.ok) {
        // Twilio error envelope: { code, message, more_info, status }.
        throw new errors.InternalError({
          code: NOTIFICATION_TRANSPORT_ERROR,
          message: `Twilio Messages API returned ${response.status}: ${
            payload?.message ?? "unknown error"
          }`,
          metadata: {
            httpStatus: response.status,
            twilioErrorCode: payload?.code ?? null,
          },
        });
      }

      return {
        sid: payload?.sid ?? "",
        status: payload?.status ?? "queued",
        errorCode: payload?.error_code ?? null,
        errorMessage: payload?.error_message ?? null,
      };
    },
  };
}

/**
 * Render the plain-text SMS body for a template. SMS bodies are kept
 * terse (one segment where possible) and PHI-free — they reference
 * internal order numbers and status codes, never patient identifiers.
 * Adding an SMS-capable template is one more case here.
 */
function renderSmsBody(
  templateId: NotificationSendInput["template"],
  context: Readonly<Record<string, unknown>>
): string {
  switch (templateId) {
    case "SHIPMENT_ESCALATED_V1": {
      const order = String(context["orderExternalNumber"]);
      const reason = String(context["escalationReason"]);
      const tracking = String(context["lastTrackingStatus"]);
      return `Pharmax: order ${order} escalated to the emergency bucket (${reason}). Last tracking status: ${tracking}. Open the ops console to claim it.`;
    }
    default:
      // Defensive: the channel guards already proved the template
      // lists "sms" in its channelKinds, so a template that reaches
      // here without a renderer is a wiring bug — fail loud rather
      // than send a blank text.
      throw new errors.InternalError({
        code: "NOTIFICATION_RENDERER_MISSING",
        message: `TwilioSmsNotificationChannel has no renderer for template "${templateId}".`,
        metadata: { templateId },
      });
  }
}
