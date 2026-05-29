// PersistentNotificationChannel — a `NotificationChannel` decorator
// that records a `notification_delivery` row around every
// tenant-scoped send.
//
// Wraps any inner channel (Resend, in-memory, a future SMS/in-app
// router). On send:
//
//   1. If `input.organizationId` is absent → pass straight through
//      (no persistence). Keeps non-tenant notifications working
//      and means a caller that doesn't care about delivery
//      tracking pays nothing.
//   2. Otherwise: recordQueued → inner.send → markSent (with the
//      provider message id) on success, or markFailed on throw
//      (then re-throw so the caller's retry/backoff still fires).
//
// Persistence failures are deliberately NON-fatal for the
// recordQueued / markSent / markFailed calls: the transport send
// is the load-bearing operation; a delivery-row write hiccup must
// not turn a successful email into a failed outbox row (which
// would trigger a duplicate resend). Store errors are surfaced to
// the optional `onStoreError` hook (the app wires it to its
// logger → Sentry) and otherwise swallowed.
//
// The decorator is transport-agnostic; the Prisma binding for the
// store lives in the consuming app (see
// `apps/worker/src/notifications/prisma-notification-delivery-store.ts`).

import type {
  NotificationChannel,
  NotificationChannelMetadata,
  NotificationSendInput,
  NotificationSendResult,
} from "../ports/notification-channel.js";
import type { NotificationDeliveryStore } from "../ports/notification-delivery-store.js";

export interface PersistentNotificationChannelOptions {
  readonly inner: NotificationChannel;
  readonly store: NotificationDeliveryStore;
  /**
   * Invoked when a store call (recordQueued/markSent/markFailed)
   * throws. The transport send is unaffected. Wire to the app
   * logger so a persistence regression is visible without
   * breaking delivery.
   */
  readonly onStoreError?: (
    stage: "recordQueued" | "markSent" | "markFailed",
    cause: unknown
  ) => void;
}

export class PersistentNotificationChannel implements NotificationChannel {
  private readonly inner: NotificationChannel;
  private readonly store: NotificationDeliveryStore;
  private readonly onStoreError: (
    stage: "recordQueued" | "markSent" | "markFailed",
    cause: unknown
  ) => void;

  constructor(options: PersistentNotificationChannelOptions) {
    this.inner = options.inner;
    this.store = options.store;
    this.onStoreError = options.onStoreError ?? (() => {});
  }

  get metadata(): NotificationChannelMetadata {
    return this.inner.metadata;
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    const organizationId = input.organizationId;
    if (organizationId === undefined) {
      // No tenant scope → no delivery row. Pass through.
      return this.inner.send(input);
    }

    await this.safeStore("recordQueued", () =>
      this.store.recordQueued({
        organizationId,
        idempotencyKey: input.idempotencyKey,
        template: input.template,
        channelName: this.inner.metadata.name,
        recipientKind: input.to.kind,
        recipientAddress: input.to.address,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      })
    );

    try {
      const result = await this.inner.send(input);
      await this.safeStore("markSent", () =>
        this.store.markSent({
          organizationId,
          idempotencyKey: input.idempotencyKey,
          providerMessageId: result.deliveryId,
        })
      );
      return result;
    } catch (cause) {
      await this.safeStore("markFailed", () =>
        this.store.markFailed({
          organizationId,
          idempotencyKey: input.idempotencyKey,
          failureReason: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
        })
      );
      throw cause;
    }
  }

  private async safeStore(
    stage: "recordQueued" | "markSent" | "markFailed",
    fn: () => Promise<void>
  ): Promise<void> {
    try {
      await fn();
    } catch (cause) {
      this.onStoreError(stage, cause);
    }
  }
}
