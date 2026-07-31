// NotificationChannelComplianceNotifier — production `ComplianceNotifier`
// adapter.
//
// The quarterly access-review job ends each org's run by handing a
// `ComplianceNotice` to the configured notifier. The default is the
// structured-log stub (`LoggingComplianceNotifier`) — fine for dev,
// but production compliance nudges must actually land in an inbox.
//
// This adapter delivers notices through the worker's existing
// notification channel (the same Resend-backed channel that powers
// scheduled-report emails and the nightly security digest) via the
// COMPLIANCE_NOTICE_V1 template. Sibling of
// `NotificationChannelDigestPublisher` — same recipient semantics,
// same channel contract, same PHI posture.
//
// Recipient model: ONE operator-side compliance address (typically a
// group alias like `compliance@<operator-domain>`), NOT per-tenant
// inboxes. The notice references a tenant org by id/slug but the
// audience is the operator's compliance function, which walks the
// evidence pack and dispatches the sign-off command. We intentionally
// do NOT resolve tenant OrgAdmin emails here — emailing tenants
// compliance evidence is a product decision that would need its own
// review, template, and per-org recipient plumbing.
//
// PHI safety: the `ComplianceNotifier` port contract forbids PHI in
// notice bodies (operator emails, aggregate counts, evidence URIs
// only). COMPLIANCE_NOTICE_V1 is `phiAllowed: false`, so the
// channel's structural sentinel gate backstops that contract.
//
// Idempotency: the key hashes `kind + organizationId + subject`. The
// access-review subject embeds the quarter label ("Q3 2026 access
// review ready for acme"), so a worker restart that replays the same
// quarter's run resolves to the SAME Resend message id instead of
// re-nudging the reviewer, while next quarter's notice (new subject)
// sends fresh. Deriving from notice content — not a process nonce —
// keeps the key stable across restarts.

import { createHash } from "node:crypto";

import { type NotificationChannel, type NotificationRecipient } from "@pharmax/notifications";

import {
  type ComplianceNotice,
  type ComplianceNotifier,
  type ComplianceNotifyResult,
} from "./compliance-notifier.js";

export interface NotificationChannelComplianceNotifierOptions {
  /** The channel to deliver through. In production this is the
   *  `PersistentNotificationChannel` wrapped around
   *  `ResendNotificationChannel` the worker already configures. */
  readonly channel: NotificationChannel;
  /** Operator compliance address. Single string — the channel's
   *  contract is one-recipient-per-send; use a group alias to fan
   *  out (same rationale as the digest publisher). */
  readonly recipientEmail: string;
  /** Optional idempotency-key prefix; default keeps the notifier
   *  self-contained. */
  readonly idempotencyKeyPrefix?: string;
  /** Optional correlation id propagated into the channel send. */
  readonly correlationId?: string;
}

const DEFAULT_IDEMPOTENCY_KEY_PREFIX = "compliance-notice";

export class NotificationChannelComplianceNotifier implements ComplianceNotifier {
  private readonly channel: NotificationChannel;
  private readonly recipient: NotificationRecipient;
  private readonly idempotencyKeyPrefix: string;
  private readonly correlationId: string | undefined;

  public constructor(options: NotificationChannelComplianceNotifierOptions) {
    if (typeof options.recipientEmail !== "string" || options.recipientEmail.trim().length === 0) {
      throw new Error(
        "NotificationChannelComplianceNotifier: recipientEmail must be a non-empty string"
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

  public async notify(notice: ComplianceNotice): Promise<ComplianceNotifyResult> {
    const fingerprint = createHash("sha256")
      .update(`${notice.kind}\u0000${notice.organizationId}\u0000${notice.subject}`)
      .digest("hex")
      .slice(0, 16);
    const idempotencyKey = `${this.idempotencyKeyPrefix}:${notice.kind}:${fingerprint}`;

    const result = await this.channel.send({
      to: this.recipient,
      template: "COMPLIANCE_NOTICE_V1",
      context: buildContext(notice),
      idempotencyKey,
      ...(this.correlationId !== undefined ? { correlationId: this.correlationId } : {}),
      // The notice concerns one tenant org, so we DO pass
      // organizationId — the persistence decorator writes the
      // tenant-scoped `notification_delivery` ledger row, giving
      // each org's evidence trail a record that its review nudge
      // was actually dispatched.
      organizationId: notice.organizationId,
    });
    return Object.freeze({ transportId: result.deliveryId });
  }
}

/**
 * Build the typed context COMPLIANCE_NOTICE_V1 needs. KEEP IN SYNC
 * with `requiredContextKeys` on the template definition in
 * `@pharmax/notifications` — the channel's
 * `assertRequiredContextKeysPresent` gate throws at runtime if a
 * key is missing here.
 */
function buildContext(notice: ComplianceNotice): Readonly<Record<string, unknown>> {
  return Object.freeze({
    noticeKind: notice.kind,
    organizationId: notice.organizationId,
    subject: notice.subject,
    body: notice.body,
    severity: notice.severity ?? "info",
    ...(notice.evidenceUri !== undefined ? { evidenceUri: notice.evidenceUri } : {}),
  });
}
