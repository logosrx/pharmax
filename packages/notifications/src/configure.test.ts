// Configure singleton — same shape as @pharmax/package-capture and
// @pharmax/crypto. Pinning the contract here keeps the boot
// behavior identical across packages.

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryNotificationChannel } from "./adapters/in-memory-notification-channel.js";
import {
  configureNotifications,
  getNotificationChannel,
  resetNotificationsConfigurationForTests,
} from "./configure.js";

afterEach(() => {
  resetNotificationsConfigurationForTests();
});

describe("configureNotifications", () => {
  it("throws InternalError(NOTIFICATIONS_NOT_CONFIGURED) when unconfigured", () => {
    expect(() => getNotificationChannel()).toThrowError(
      expect.objectContaining({ code: "NOTIFICATIONS_NOT_CONFIGURED" })
    );
  });

  it("returns the configured channel", () => {
    const channel = new InMemoryNotificationChannel();
    configureNotifications({ channel });
    expect(getNotificationChannel()).toBe(channel);
  });

  it("the second call replaces the first channel", () => {
    const a = new InMemoryNotificationChannel({ name: "a" });
    const b = new InMemoryNotificationChannel({ name: "b" });
    configureNotifications({ channel: a });
    configureNotifications({ channel: b });
    expect(getNotificationChannel()).toBe(b);
  });

  it("reset returns to the unconfigured state", () => {
    configureNotifications({ channel: new InMemoryNotificationChannel() });
    resetNotificationsConfigurationForTests();
    expect(() => getNotificationChannel()).toThrowError(
      expect.objectContaining({ code: "NOTIFICATIONS_NOT_CONFIGURED" })
    );
  });
});
