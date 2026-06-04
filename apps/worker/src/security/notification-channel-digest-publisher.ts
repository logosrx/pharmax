// NotificationChannelDigestPublisher — production `DigestPublisher`
// adapter.
//
// The nightly security digest loop produces a `SecurityDigest` +
// renders it via `renderDigestAsText` (in @pharmax/security), then
// hands the pair to a `DigestPublisher.publish(digest, rendered)`.
// The default implementation is the in-memory publisher — it logs
// `digest.published` at INFO and that's the SOC 2 evidence today.
//
// This adapter swaps the in-memory publisher for the worker's
// existing notification channel (the same Resend-backed channel
// that powers scheduled-report emails) and delivers the digest
// to the configured security distribution list. Concretely:
//
//   - Composes a typed context payload from the digest aggregates
//     + the pre-rendered text body.
//   - Sends via the SECURITY_DIGEST_DAILY_V1 template (registered
//     in @pharmax/notifications) which the channel's renderer
//     dispatcher knows about.
//   - Returns the channel's delivery id as the `transportId` so
//     the loop's `digest.published` log line correlates 1:1 with
//     the `notification_delivery` ledger row (and with the Resend
//     vendor message id when the production transport is wired).
//
// PHI safety: the digest is non-PHI by construction (the composer
// emits counts + ids + status enums only). The notification
// channel's PHI sentinel gate still fires structurally on
// SECURITY_DIGEST_DAILY_V1 — that template is `phiAllowed: false`
// so a future regression that accidentally embedded a `patientName`
// key in the context would fail closed at the channel boundary
// before any bytes leave the process. See the template's header
// comment in `@pharmax/notifications`.
//
// Idempotency: the idempotency key encodes the digest's
// `generatedAt` ISO timestamp. The scheduler fires once per UTC
// day; two retries of the same run (worker restart inside the
// scheduler's debounce window, etc.) resolve to the same Resend
// vendor message id rather than producing two emails. The key
// is stable across worker restarts because it derives from the
// digest's own state, not from a process-local nonce.

import { type NotificationChannel, type NotificationRecipient } from "@pharmax/notifications";
import { type DigestPublisher, type SecurityDigest } from "@pharmax/security";

export interface NotificationChannelDigestPublisherOptions {
  /** The channel to deliver through. In production this is the
   *  `PersistentNotificationChannel` wrapped around `ResendNotificationChannel`
   *  the worker already configures for scheduled-report fan-out. */
  readonly channel: NotificationChannel;
  /** Recipient email address. Single string (not an array) — the
   *  channel's contract is one-recipient-per-send by design. To
   *  fan out to a distribution list, configure the address as a
   *  group alias (`security@<operator-domain>`) at the email
   *  vendor / Workspace / Google Groups layer; we do NOT loop here
   *  because the `Idempotency-Key` header is per-send and a
   *  client-side loop would double-charge Resend dedupe credit. */
  readonly recipientEmail: string;
  /** Optional prefix for the idempotency key. Default keeps the
   *  publisher self-contained; an integrator that runs multiple
   *  digest publishers against the same channel (e.g. one per
   *  digest variant) supplies a unique prefix to keep their
   *  idempotency keys partitioned. */
  readonly idempotencyKeyPrefix?: string;
  /** Optional correlation id propagated into the channel send for
   *  cross-trace correlation. Tests can pin a known value here. */
  readonly correlationId?: string;
}

const DEFAULT_IDEMPOTENCY_KEY_PREFIX = "security-digest";

export class NotificationChannelDigestPublisher implements DigestPublisher {
  private readonly channel: NotificationChannel;
  private readonly recipient: NotificationRecipient;
  private readonly idempotencyKeyPrefix: string;
  private readonly correlationId: string | undefined;

  public constructor(options: NotificationChannelDigestPublisherOptions) {
    if (typeof options.recipientEmail !== "string" || options.recipientEmail.trim().length === 0) {
      throw new Error(
        "NotificationChannelDigestPublisher: recipientEmail must be a non-empty string"
      );
    }
    this.channel = options.channel;
    this.recipient = Object.freeze({
      kind: "email" as const,
      address: options.recipientEmail,
    });
    this.idempotencyKeyPrefix = options.idempotencyKeyPrefix ?? DEFAULT_IDEMPOTENCY_KEY_PREFIX;
    this.correlationId = options.correlationId;
  }

  public async publish(
    digest: SecurityDigest,
    rendered: string
  ): Promise<{ readonly transportId: string }> {
    const context = buildContext(digest, rendered);
    const idempotencyKey = `${this.idempotencyKeyPrefix}:${digest.generatedAt}`;

    const result = await this.channel.send({
      to: this.recipient,
      template: "SECURITY_DIGEST_DAILY_V1",
      context,
      idempotencyKey,
      ...(this.correlationId !== undefined ? { correlationId: this.correlationId } : {}),
      // Intentionally NO `organizationId` — the digest aggregates
      // ACROSS orgs, and the recipient is the operator's security
      // distribution list (not a tenant address). The persistence
      // decorator skips the `notification_delivery` ledger when
      // organizationId is absent — which is the correct outcome
      // here, since the ledger is RLS-scoped per org and a digest
      // row would have no natural tenant to assign to.
    });
    return Object.freeze({ transportId: result.deliveryId });
  }
}

/**
 * Build the typed context the SECURITY_DIGEST_DAILY_V1 template
 * needs. Aggregates the four scalar counts the renderer uses for
 * the subject line + carries the pre-rendered text body verbatim.
 *
 * KEEP IN SYNC with `requiredContextKeys` on the template
 * definition in `@pharmax/notifications`. The channel's
 * `assertRequiredContextKeysPresent` gate will throw at runtime if
 * a key is missing here.
 */
function buildContext(digest: SecurityDigest, rendered: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    generatedAtIso: digest.generatedAt,
    windowFromIso: digest.windowStart,
    windowToIso: digest.windowEnd,
    digestText: rendered,
    auditOrgCount: digest.auditChainStatuses.length,
    brokenChainCount: digest.auditChainStatuses.filter((s) => !s.valid).length,
    breakGlassCount: digest.breakGlassSessions.length,
    outboxDeadCount: digest.outboxStatuses.length,
  });
}
