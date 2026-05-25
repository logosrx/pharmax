// Validates the PHI-safe Sentry scrubber. These tests are the ONLY
// gate between a developer accident and PHI leaving the process via
// Sentry — when changing the scrubber, update these tests first.

import { describe, expect, it } from "vitest";

// `ErrorEvent` is the v8 subtype seen by `beforeSend` — match what
// the scrubber actually receives so the fixture types do not lie.
import type { Breadcrumb, ErrorEvent } from "@sentry/core";

import { buildBeforeSend, scrubBreadcrumb, __testing } from "./sentry-scrubber.js";

/**
 * Sentry v8's `ErrorEvent` requires `type: undefined` as a
 * discriminator. The test fixtures focus on the fields under test, so
 * we add the discriminator via a helper instead of cluttering every
 * fixture with it.
 */
function asErrorEvent(partial: Omit<ErrorEvent, "type">): ErrorEvent {
  return { type: undefined, ...partial };
}

const { scrubUrl, scrubObjectByAllowlist, ALLOWED_METADATA_KEYS } = __testing;

describe("scrubUrl", () => {
  it("strips query string but keeps path", () => {
    expect(scrubUrl("https://app.test/api/patients/123?search=Alice")).toBe(
      "https://app.test/api/patients/123"
    );
  });

  it("leaves a path-only URL alone", () => {
    expect(scrubUrl("/api/orders/abc")).toBe("/api/orders/abc");
  });
});

describe("scrubObjectByAllowlist", () => {
  it("drops keys not in the allowlist", () => {
    const result = scrubObjectByAllowlist({
      organizationId: "org-1",
      patientFirstName: "Alice",
      orderId: "ord-1",
      addressLine1: "123 Main St",
    });
    expect(result).toEqual({ organizationId: "org-1", orderId: "ord-1" });
  });

  it("returns undefined for undefined input", () => {
    expect(scrubObjectByAllowlist(undefined)).toBeUndefined();
  });

  it("preserves all allowlisted tenancy keys", () => {
    const allKeys: Record<string, unknown> = {};
    for (const key of ALLOWED_METADATA_KEYS) {
      allKeys[key] = "v";
    }
    const result = scrubObjectByAllowlist(allKeys);
    expect(Object.keys(result!).sort()).toEqual(Array.from(ALLOWED_METADATA_KEYS).sort());
  });
});

describe("scrubBreadcrumb", () => {
  it("redacts console breadcrumb messages entirely", () => {
    const crumb: Breadcrumb = {
      category: "console",
      level: "error",
      message: "patient Alice DOB 1980-01-01",
      timestamp: 1,
    };
    expect(scrubBreadcrumb(crumb)).toEqual({
      type: undefined,
      category: "console",
      level: "error",
      message: "[Redacted]",
      timestamp: 1,
    });
  });

  it("strips query string from breadcrumb data.url", () => {
    const crumb: Breadcrumb = {
      category: "fetch",
      data: {
        url: "/api/patients?search=Alice",
        method: "GET",
        organizationId: "org-1",
      },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(scrubbed?.data).toEqual({
      url: "/api/patients",
      organizationId: "org-1",
    });
    expect(scrubbed?.data?.method).toBeUndefined();
  });
});

describe("buildBeforeSend", () => {
  const beforeSend = buildBeforeSend({ enabledInEnvironment: true });

  it("returns null when disabled in environment (drops all events)", () => {
    const disabled = buildBeforeSend({ enabledInEnvironment: false });
    const event = asErrorEvent({ message: "x" });
    expect(disabled(event, {})).toBeNull();
  });

  it("strips request.headers, cookies, data, query_string", () => {
    const event = asErrorEvent({
      request: {
        url: "https://app.test/api/patients?ssn=123-45-6789",
        headers: { authorization: "Bearer abc", cookie: "sess=xyz" },
        cookies: { sess: "xyz" },
        data: { firstName: "Alice", dob: "1980-01-01" },
        query_string: "ssn=123-45-6789",
      },
    });
    const result = beforeSend(event, {})!;
    expect(result.request).toEqual({
      url: "https://app.test/api/patients",
    });
  });

  it("strips user fields except id", () => {
    const event = asErrorEvent({
      user: {
        id: "u-1",
        email: "alice@example.com",
        username: "alice",
        ip_address: "10.0.0.1",
      },
    });
    const result = beforeSend(event, {})!;
    expect(result.user).toEqual({ id: "u-1" });
  });

  it("allowlist-scrubs extra and tags", () => {
    const event = asErrorEvent({
      extra: {
        organizationId: "org-1",
        orderId: "ord-1",
        patientName: "Alice",
        rawBody: "...",
      },
      tags: {
        commandName: "CreateOrder",
        randomDebugTag: "Alice DOB 1980",
      },
    });
    const result = beforeSend(event, {})!;
    expect(result.extra).toEqual({ organizationId: "org-1", orderId: "ord-1" });
    expect(result.tags).toEqual({ commandName: "CreateOrder" });
  });

  it("preserves runtime/os/device/trace contexts and scrubs custom ones", () => {
    const event = asErrorEvent({
      contexts: {
        runtime: { name: "node", version: "22" },
        os: { name: "linux" },
        custom: { organizationId: "org-1", patientName: "Alice" },
      },
    });
    const result = beforeSend(event, {})!;
    expect(result.contexts?.runtime).toEqual({ name: "node", version: "22" });
    expect(result.contexts?.os).toEqual({ name: "linux" });
    expect(result.contexts?.custom).toEqual({ organizationId: "org-1" });
  });

  it("scrubs every breadcrumb in the event", () => {
    const event = asErrorEvent({
      breadcrumbs: [
        {
          category: "console",
          level: "error",
          message: "patient Alice DOB 1980",
          timestamp: 1,
        },
        {
          category: "fetch",
          data: { url: "/api/x?q=secret", organizationId: "o-1" },
          timestamp: 2,
        },
      ],
    });
    const result = beforeSend(event, {})!;
    expect(result.breadcrumbs).toHaveLength(2);
    expect(result.breadcrumbs![0]!.message).toBe("[Redacted]");
    expect(result.breadcrumbs![1]!.data).toEqual({
      url: "/api/x",
      organizationId: "o-1",
    });
  });

  it("caps exception.value at 500 chars to limit PHI surface in dedupe key", () => {
    const longValue = "x".repeat(600);
    const event = asErrorEvent({
      exception: {
        values: [{ type: "Error", value: longValue }],
      },
    });
    const result = beforeSend(event, {})!;
    expect(result.exception!.values![0]!.value!.length).toBeLessThanOrEqual(501);
    expect(result.exception!.values![0]!.value!.endsWith("…")).toBe(true);
  });

  it("returns the event when there is nothing PHI-suspicious to scrub", () => {
    const event = asErrorEvent({
      message: "audit_chain.invalid",
      extra: { organizationId: "org-1" },
    });
    const result = beforeSend(event, {})!;
    expect(result.message).toBe("audit_chain.invalid");
    expect(result.extra).toEqual({ organizationId: "org-1" });
  });
});
