import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";

import { scrubWorkerEvent } from "./sentry-init.js";

/**
 * These tests exist because the 2026 incident-response tabletop walked a
 * scenario this process could not survive, and found the reason nobody
 * had noticed was that nothing asserted the behaviour. See
 * `evidence/dr-drills/2026/incident-tabletop.md` and R-018.
 */
describe("scrubWorkerEvent", () => {
  it("redacts PHI from an exception message — the tabletop scenario", () => {
    // The exact shape that motivated this: a carrier API error echoing
    // the addressee back to us. Well under the old 500-character cap,
    // so truncation never touched it, and the `extra` allowlist never
    // applied because a stack trace has no keys.
    const event = {
      exception: {
        values: [
          {
            type: "CarrierError",
            value: "Failed to create label for Jane Smith, 123 Main St, Springfield IL 62701",
          },
        ],
      },
    } as unknown as ErrorEvent;

    const out = scrubWorkerEvent(event);
    const message = out.exception?.values?.[0]?.value ?? "";

    expect(message).not.toContain("123 Main St");
    expect(message).toContain("[address]");
  });

  it("redacts event.message, which was previously untouched entirely", () => {
    const event = { message: "notify jane.doe@example.com about 555-867-5309" } as ErrorEvent;
    const out = scrubWorkerEvent(event);

    expect(out.message).not.toContain("jane.doe@example.com");
    expect(out.message).toContain("[email]");
    expect(out.message).toContain("[phone]");
  });

  it("redacts breadcrumb messages, where a carrier response lands before the throw", () => {
    const event = {
      breadcrumbs: [{ message: "POST /labels for 400 Oak Avenue returned 422" }],
    } as ErrorEvent;

    const out = scrubWorkerEvent(event);
    expect(out.breadcrumbs?.[0]?.message).toContain("[address]");
    expect(out.breadcrumbs?.[0]?.message).not.toContain("400 Oak Avenue");
  });

  it("drops breadcrumb data keys that are not on the allowlist", () => {
    const event = {
      breadcrumbs: [{ message: "ok", data: { orderId: "ord-1", patientName: "Jane Smith" } }],
    } as unknown as ErrorEvent;

    const out = scrubWorkerEvent(event);
    expect(out.breadcrumbs?.[0]?.data).toEqual({ orderId: "ord-1" });
  });

  it("keeps allowlisted extra keys and drops everything else", () => {
    const event = {
      extra: { organizationId: "org-1", patientFirstName: "Jane" },
    } as unknown as ErrorEvent;

    const out = scrubWorkerEvent(event);
    expect(out.extra).toEqual({ organizationId: "org-1" });
  });

  it("strips request data wholesale — the worker has no HTTP surface", () => {
    const event = { request: { url: "https://x/api/patients/123?search=smith" } } as ErrorEvent;
    expect(scrubWorkerEvent(event).request).toBeUndefined();
  });

  it("reduces user context to an id", () => {
    const event = {
      user: { id: "u-1", email: "op@example.com", username: "operator" },
    } as ErrorEvent;

    expect(scrubWorkerEvent(event).user).toEqual({ id: "u-1" });
  });

  it("removes user context entirely when there is no id to keep", () => {
    const event = { user: { email: "op@example.com" } } as ErrorEvent;
    expect(scrubWorkerEvent(event).user).toBeUndefined();
  });

  it("leaves an operational message untouched", () => {
    const clean = "drain tick failed: connection reset";
    const event = { message: clean } as ErrorEvent;
    expect(scrubWorkerEvent(event).message).toBe(clean);
  });

  it("caps a long message after redacting, not before", () => {
    const event = { message: `${"x".repeat(600)} at 123 Main Street` } as ErrorEvent;
    const out = scrubWorkerEvent(event);

    expect(out.message).not.toContain("123 Main Street");
    expect(out.message).not.toContain("123 Mai");
    expect((out.message ?? "").length).toBeLessThanOrEqual(501);
  });
});
