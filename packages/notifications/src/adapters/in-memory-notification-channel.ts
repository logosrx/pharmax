// In-memory NotificationChannel adapter.
//
// Used by tests and ephemeral dev. Records every send for
// assertion-friendly read-back. NOT suitable for production:
//
//   - No persistence (process restart loses every recorded send).
//   - No real delivery (the "delivery" is appending to an array).
//   - No retry / backoff — failure injection is one-shot per call.
//
// The production composition will wire concrete transports
// (Resend, Twilio, in-app DB) behind a router that satisfies the
// same `NotificationChannel` interface. Swapping is one boot-time
// line.
//
// Idempotency: this adapter dedupes by `idempotencyKey`. Two calls
// with the same key resolve to the SAME `deliveryId` and the
// second call returns `status: "deduplicated"`. The recorded log
// shows only the FIRST send; subsequent dedupe hits don't add a
// row (otherwise the read-back wouldn't be a useful diagnostic
// for "did we send this exactly once?").

import { randomUUID } from "node:crypto";

import { errors } from "@pharmax/platform-core";

import {
  assertChannelSupportsRecipient,
  assertNoPhiInContext,
  assertRequiredContextKeysPresent,
  assertTemplateAllowsRecipient,
  NOTIFICATION_TRANSPORT_ERROR,
  type NotificationChannel,
  type NotificationChannelMetadata,
  type NotificationSendInput,
  type NotificationSendResult,
} from "../ports/notification-channel.js";
import {
  getTemplate,
  type NotificationRecipientKind,
  type NotificationTemplateId,
} from "../templates/template-registry.js";

/** Constructor options. */
export interface InMemoryNotificationChannelOptions {
  /** Channel name reported in metadata + error envelopes. Defaults
   *  to `"in-memory"`. */
  readonly name?: string;
  /** Kinds this channel claims it can deliver to. Defaults to all
   *  three (email / sms / in-app) so tests don't have to pick. A
   *  test that wants to verify the "wrong kind" guard can pass a
   *  narrowed list. */
  readonly supportedRecipientKinds?: ReadonlyArray<NotificationRecipientKind>;
  /** When `true`, the channel reports itself as PHI-capable.
   *  Defaults to `false` so the safe-by-default rule holds even
   *  for tests. */
  readonly phiCapable?: boolean;
}

/** One recorded send. Exposed read-only via `getSent()`. */
export interface RecordedNotification {
  readonly deliveryId: string;
  readonly template: NotificationTemplateId;
  readonly recipient: {
    readonly kind: NotificationRecipientKind;
    readonly address: string;
  };
  readonly context: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly correlationId: string | null;
  readonly sentAt: Date;
}

interface FailureSpec {
  readonly code: string;
  readonly message: string;
}

export class InMemoryNotificationChannel implements NotificationChannel {
  public readonly metadata: NotificationChannelMetadata;

  // idempotencyKey → first deliveryId we minted for it.
  private readonly seenIdempotencyKeys = new Map<string, string>();
  private readonly recorded: RecordedNotification[] = [];
  private pendingFailure: FailureSpec | null = null;

  constructor(options: InMemoryNotificationChannelOptions = {}) {
    this.metadata = Object.freeze({
      name: options.name ?? "in-memory",
      supportedRecipientKinds: Object.freeze(
        (options.supportedRecipientKinds ?? ["email", "sms", "in-app"]).slice()
      ),
      phiCapable: options.phiCapable ?? false,
    });
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    // Validation gates run BEFORE the failure injector so a test
    // that wants to verify "validation runs even when transport
    // would have failed" sees the validation error, not the
    // injected one.
    const template = getTemplate(input.template);
    assertChannelSupportsRecipient(this.metadata, input.to);
    assertTemplateAllowsRecipient(template, input.to);
    assertRequiredContextKeysPresent(template, input.context);
    assertNoPhiInContext(template, this.metadata, input.context);

    // Failure injection — one-shot, consumed on use. Tests use
    // this to exercise the "downstream transport blew up" path
    // without spinning a real failing transport.
    if (this.pendingFailure !== null) {
      const failure = this.pendingFailure;
      this.pendingFailure = null;
      throw new errors.InternalError({
        code: failure.code,
        message: failure.message,
      });
    }

    const seen = this.seenIdempotencyKeys.get(input.idempotencyKey);
    if (seen !== undefined) {
      return {
        deliveryId: seen,
        status: "deduplicated",
        recipientKind: input.to.kind,
        sentAt: new Date(),
      };
    }

    const deliveryId = randomUUID();
    const sentAt = new Date();
    this.seenIdempotencyKeys.set(input.idempotencyKey, deliveryId);
    this.recorded.push(
      Object.freeze({
        deliveryId,
        template: input.template,
        recipient: Object.freeze({
          kind: input.to.kind,
          address: input.to.address,
        }),
        context: Object.freeze({ ...input.context }),
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId ?? null,
        sentAt,
      })
    );

    return {
      deliveryId,
      status: "delivered",
      recipientKind: input.to.kind,
      sentAt,
    };
  }

  /** Read-back for tests. Returns a defensive copy. */
  getSent(): ReadonlyArray<RecordedNotification> {
    return this.recorded.slice();
  }

  /** Read-back filtered by template id — common shape for
   *  "verify exactly one INVOICE_PAYMENT_FAILED_V1 fired" assertions. */
  getSentForTemplate(template: NotificationTemplateId): ReadonlyArray<RecordedNotification> {
    return this.recorded.filter((r) => r.template === template);
  }

  /** Total recorded sends (deduped retries DO NOT count). */
  size(): number {
    return this.recorded.length;
  }

  /** Drop every recorded send + dedup index. */
  clear(): void {
    this.seenIdempotencyKeys.clear();
    this.recorded.length = 0;
    this.pendingFailure = null;
  }

  /**
   * Queue a one-shot transport failure for the NEXT `send` call.
   * The failure surfaces as `errors.InternalError` with the
   * provided `code` (defaults to `NOTIFICATION_TRANSPORT_ERROR`)
   * — mirroring what a real Resend / Twilio adapter would throw on
   * a 5xx vendor error.
   *
   * Validation guards still run first. If the input is itself
   * invalid (PHI in context, missing required key, etc.) the
   * validation error wins; the failure stays queued for the next
   * valid send.
   */
  failNext(spec?: { readonly code?: string; readonly message?: string }): void {
    this.pendingFailure = {
      code: spec?.code ?? NOTIFICATION_TRANSPORT_ERROR,
      message:
        spec?.message ?? "Simulated downstream transport failure (in-memory adapter failNext()).",
    };
  }
}
