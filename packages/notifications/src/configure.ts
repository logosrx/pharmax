// Process-wide NotificationChannel configuration.
//
// One process, one channel singleton. Set at boot (apps/web,
// apps/worker, scripts). Reading without configuration throws
// `InternalError(NOTIFICATIONS_NOT_CONFIGURED)` — silence here
// would let a notification call site silently no-op, which
// defeats the purpose of having a structural alerting layer.
//
// Mirrors `@pharmax/package-capture`'s `configurePackagePhotoStorage`
// and `@pharmax/crypto`'s `configureCrypto` — same pattern, so a
// reader who has internalized one knows the rest.
//
// Production composition will likely wrap a ROUTER adapter behind
// this singleton that dispatches to per-kind transports (Resend
// for email, Twilio for SMS, the `notification_in_app` table for
// in-app). The router is just another `NotificationChannel` from
// this layer's perspective.

import { errors, runtime } from "@pharmax/platform-core";

import type { NotificationChannel } from "./ports/notification-channel.js";

export const NOTIFICATIONS_NOT_CONFIGURED = "NOTIFICATIONS_NOT_CONFIGURED" as const;

export interface NotificationsConfiguration {
  readonly channel: NotificationChannel;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<NotificationsConfiguration>("pharmax:notifications:config");

/** Wire the process-wide notification channel. Call once at boot. */
export function configureNotifications(config: NotificationsConfiguration): void {
  box.value = Object.freeze({ channel: config.channel });
}

/** Returns the configured channel. Throws if `configureNotifications`
 *  was never called. */
export function getNotificationChannel(): NotificationChannel {
  if (box.value === null) {
    throw new errors.InternalError({
      code: NOTIFICATIONS_NOT_CONFIGURED,
      message:
        "@pharmax/notifications is not configured. Call configureNotifications({ channel }) at process boot before any send.",
    });
  }
  return box.value.channel;
}

/** Test-only: reset configuration. Production code MUST NOT call this. */
export function resetNotificationsConfigurationForTests(): void {
  box.value = null;
}
