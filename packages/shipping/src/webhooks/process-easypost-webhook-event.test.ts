// Worker-dispatch unit tests for the EasyPost webhook pipeline.
//
// These tests inject a fake `WebhookTargetResolver` so we exercise
// the dispatch outcomes (succeeded with unknown target, failed with
// resolver throw, terminal failure once max attempts is reached)
// WITHOUT going through the command bus. The end-to-end happy path
// (resolver → tenancy → command bus → shipment update) is covered
// by integration tests against a real database (`pnpm
// test:integration`), out of scope for unit-level vitest.

import { logger as loggerNs } from "@pharmax/platform-core";
import { beforeEach, describe, expect, it } from "vitest";

import type { EasyPostTrackerWebhookPayload } from "../carriers/easypost-payload.js";

import { EasyPostWebhookEventNotFoundError } from "./errors.js";
import { InMemoryEasyPostWebhookEventStore } from "./in-memory-event-store.js";
import {
  executeEasyPostWebhookEventDispatch,
  processEasyPostWebhookEvent,
  type WebhookTargetResolver,
} from "./process-easypost-webhook-event.js";

const NOW = new Date("2026-05-24T18:00:02.000Z");

function trackerEvent(
  overrides: Partial<EasyPostTrackerWebhookPayload> = {}
): EasyPostTrackerWebhookPayload {
  return {
    id: "evt_test_1",
    description: "tracker.updated",
    result: {
      id: "trk_xyz",
      tracking_code: "9400111899223344556677",
      status: "in_transit",
      updated_at: "2026-05-24T18:00:00Z",
      carrier: "USPS",
      ...((overrides as { result?: object }).result ?? {}),
    },
    ...overrides,
  } as EasyPostTrackerWebhookPayload;
}

function unknownTargetResolver(): WebhookTargetResolver {
  return { resolve: async () => null };
}

function throwingTargetResolver(message: string): WebhookTargetResolver {
  return {
    resolve: async () => {
      throw new Error(message);
    },
  };
}

describe("processEasyPostWebhookEvent — short-circuit branches", () => {
  let eventStore: InMemoryEasyPostWebhookEventStore;

  beforeEach(() => {
    eventStore = new InMemoryEasyPostWebhookEventStore();
  });

  it("throws EasyPostWebhookEventNotFoundError when the row is missing", async () => {
    await expect(
      processEasyPostWebhookEvent("evt_missing_1", {
        eventStore,
        targetResolver: unknownTargetResolver(),
        logger: loggerNs.noopLogger,
        clock: () => NOW,
      })
    ).rejects.toBeInstanceOf(EasyPostWebhookEventNotFoundError);
  });

  it("returns succeeded without re-running for an already-SUCCEEDED row", async () => {
    const event = trackerEvent({ id: "evt_already_succeeded_1" });
    await eventStore.recordReceived({
      event,
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    await eventStore.markSucceeded(event.id, NOW);

    const result = await processEasyPostWebhookEvent(event.id, {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    });

    expect(result.status).toBe("succeeded");
    expect(result.record.status).toBe("SUCCEEDED");
  });

  it("returns ignored without re-running for an already-IGNORED row", async () => {
    const event = trackerEvent({ id: "evt_already_ignored_1" });
    await eventStore.recordReceived({
      event,
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "IGNORED",
    });

    const result = await processEasyPostWebhookEvent(event.id, {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    });

    expect(result.status).toBe("ignored");
    expect(result.record.status).toBe("IGNORED");
  });

  it("marks SUCCEEDED when the resolver returns null (unknown tracking code)", async () => {
    const event = trackerEvent({ id: "evt_unknown_ship_1" });
    const { record } = await eventStore.recordReceived({
      event,
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });

    const result = await executeEasyPostWebhookEventDispatch(record, {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    });

    expect(result.status).toBe("succeeded");
    expect(result.record.status).toBe("SUCCEEDED");
    expect(result.record.lastError).toBeNull();
  });
});

describe("executeEasyPostWebhookEventDispatch — failure handling", () => {
  let eventStore: InMemoryEasyPostWebhookEventStore;

  beforeEach(() => {
    eventStore = new InMemoryEasyPostWebhookEventStore();
  });

  it("marks FAILED with a retry schedule when the resolver throws", async () => {
    const event = trackerEvent({ id: "evt_lookup_throws_1" });
    await eventStore.recordReceived({
      event,
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    const processing = await eventStore.markProcessing(event.id, NOW);

    const result = await executeEasyPostWebhookEventDispatch(processing, {
      eventStore,
      targetResolver: throwingTargetResolver("simulated DB outage"),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
      maxAttempts: 3,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.record.status).toBe("FAILED");
      expect(result.record.lastError).toContain("simulated DB outage");
      expect(result.retryScheduledFor).not.toBeNull();
    }
  });

  it("stops scheduling retries once max attempts is reached", async () => {
    const event = trackerEvent({ id: "evt_lookup_throws_terminal_1" });
    await eventStore.recordReceived({
      event,
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    await eventStore.markProcessing(event.id, NOW);
    await eventStore.markProcessing(event.id, NOW);
    const processing = await eventStore.markProcessing(event.id, NOW);

    const result = await executeEasyPostWebhookEventDispatch(processing, {
      eventStore,
      targetResolver: throwingTargetResolver("permanent failure"),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
      maxAttempts: 3,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.retryScheduledFor).toBeNull();
    }
  });

  it("marks FAILED when the payload has no tracking_code", async () => {
    const event = trackerEvent({ id: "evt_no_tracking_code" });
    // Force the payload to have an empty tracking_code via assertion.
    (event.result as { tracking_code: string }).tracking_code = "";
    await eventStore.recordReceived({
      event,
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    const processing = await eventStore.markProcessing(event.id, NOW);

    const result = await executeEasyPostWebhookEventDispatch(processing, {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
      maxAttempts: 3,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      // ValidationError carries the message text; the code itself
      // (EASYPOST_WEBHOOK_MISSING_TRACKING_CODE) is on the thrown
      // error's `code` property, which `describeError` does not
      // surface. The recorded message contains the human-readable
      // half — sufficient to know the failure was structural.
      expect(result.record.lastError).toContain("tracking_code");
    }
  });
});
