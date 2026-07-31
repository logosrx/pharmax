import { listRegisteredEventDefinitions } from "@pharmax/events";
import { describe, expect, it } from "vitest";

import {
  WEBHOOK_ELIGIBLE_EVENT_TYPES,
  isWebhookEligibleEventType,
  listWebhookEligibleEventTypes,
} from "./eligible-events.js";

describe("WEBHOOK_ELIGIBLE_EVENT_TYPES", () => {
  it("is EXACTLY the phi-safe subset of the event registry", () => {
    const phiSafe = new Set(
      listRegisteredEventDefinitions()
        .filter((def) => def.phiSafe)
        .map((def) => def.fullName)
    );
    expect(new Set(WEBHOOK_ELIGIBLE_EVENT_TYPES)).toEqual(phiSafe);
  });

  it("every registered non-phi-safe event is ineligible", () => {
    for (const def of listRegisteredEventDefinitions()) {
      if (!def.phiSafe) {
        expect(isWebhookEligibleEventType(def.fullName)).toBe(false);
      }
    }
  });

  it("includes the platform lifecycle events (P0 sanity)", () => {
    expect(isWebhookEligibleEventType("platform.webhook_subscription.created.v1")).toBe(true);
    expect(isWebhookEligibleEventType("platform.api_key.created.v1")).toBe(true);
  });
});

describe("isWebhookEligibleEventType", () => {
  it("rejects unknown names and non-strings", () => {
    // (Allowlisted parity-guard fixture name — intentionally unregistered.)
    expect(isWebhookEligibleEventType("some.unregistered.event.v1")).toBe(false);
    expect(isWebhookEligibleEventType(undefined)).toBe(false);
    expect(isWebhookEligibleEventType(null)).toBe(false);
    expect(isWebhookEligibleEventType(42)).toBe(false);
  });
});

describe("listWebhookEligibleEventTypes", () => {
  it("returns a sorted, frozen list matching the set", () => {
    const list = listWebhookEligibleEventTypes();
    expect(list.length).toBe(WEBHOOK_ELIGIBLE_EVENT_TYPES.size);
    expect([...list]).toEqual([...list].sort());
    expect(Object.isFrozen(list)).toBe(true);
  });
});
