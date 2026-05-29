// Public surface of @pharmax/notifications.
//
// What lives here:
//   - The `NotificationChannel` port that every adapter satisfies.
//   - The `NotificationTemplate` registry — the typed set of every
//     notification the platform can send.
//   - The boot-time `configureNotifications` singleton.
//   - The `InMemoryNotificationChannel` adapter for tests + dev.
//   - The dictionary of typed error codes the port / adapters
//     may throw.
//
// What does NOT live here (intentional follow-up slices):
//   - Production transports (Resend for email, Twilio for SMS,
//     a `notification_in_app` Prisma-backed adapter). Each ships
//     as its own slice with its own credentials, BAA review (where
//     PHI-capable), and observability hookup.
//   - Routing logic that maps domain events to template ids +
//     recipients — that belongs in the domain package that owns
//     the event, OR in a worker drain that listens to the outbox.
//     Either way, the consumer never imports a transport SDK; it
//     imports `getNotificationChannel()` and calls `.send()`.
//   - A Prisma model for delivered notifications. The first
//     production adapter to need persistence ships its own model
//     + migration; this layer stays storage-agnostic.

export {
  configureNotifications,
  getNotificationChannel,
  resetNotificationsConfigurationForTests,
  NOTIFICATIONS_NOT_CONFIGURED,
  type NotificationsConfiguration,
} from "./configure.js";

export {
  NOTIFICATION_TEMPLATES,
  PHI_SENTINEL_EXACT_KEYS,
  PHI_SENTINEL_PREFIX_KEYS,
  getTemplate,
  isNotificationTemplateId,
  listTemplateIds,
  type NotificationTemplateDefinition,
  type NotificationTemplateId,
  type NotificationRecipientKind,
} from "./templates/template-registry.js";

export {
  assertChannelSupportsRecipient,
  assertNoPhiInContext,
  assertRequiredContextKeysPresent,
  assertTemplateAllowsRecipient,
  NOTIFICATION_CONTEXT_MISSING_KEY,
  NOTIFICATION_PHI_REJECTED,
  NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED,
  NOTIFICATION_TEMPLATE_RECIPIENT_MISMATCH,
  NOTIFICATION_TRANSPORT_ERROR,
  type NotificationChannel,
  type NotificationChannelMetadata,
  type NotificationRecipient,
  type NotificationSendInput,
  type NotificationSendResult,
} from "./ports/notification-channel.js";

export {
  InMemoryNotificationChannel,
  type InMemoryNotificationChannelOptions,
  type RecordedNotification,
} from "./adapters/in-memory-notification-channel.js";

export {
  PersistentNotificationChannel,
  type PersistentNotificationChannelOptions,
} from "./adapters/persistent-notification-channel.js";

export type {
  NotificationDeliveryStore,
  NotificationDeliveryRecordQueuedInput,
  NotificationDeliveryMarkSentInput,
  NotificationDeliveryMarkFailedInput,
} from "./ports/notification-delivery-store.js";

import * as adapterModule from "./adapters/in-memory-notification-channel.js";
import * as persistentModule from "./adapters/persistent-notification-channel.js";
import * as configureModule from "./configure.js";
import * as portModule from "./ports/notification-channel.js";
import * as templateModule from "./templates/template-registry.js";

/** Convenience namespace for the consuming code that prefers a
 *  namespaced import style. */
export const notifications = {
  ...configureModule,
  ...templateModule,
  ...portModule,
  ...adapterModule,
  ...persistentModule,
} as const;
