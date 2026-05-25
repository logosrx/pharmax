import { describe, expect, it } from "vitest";

import type { EasyPostTrackerWebhookPayload } from "../carriers/easypost-payload.js";

import { InMemoryEasyPostWebhookEventStore } from "./in-memory-event-store.js";

const NOW = new Date("2026-05-24T18:00:00.000Z");

function event(id = "evt_1", status = "in_transit"): EasyPostTrackerWebhookPayload {
  return {
    id,
    description: "tracker.updated",
    result: {
      id: "trk_xyz",
      tracking_code: "1Z999",
      status,
      updated_at: NOW.toISOString(),
    },
  } as EasyPostTrackerWebhookPayload;
}

describe("InMemoryEasyPostWebhookEventStore", () => {
  it("recordReceived returns inserted=true on first insert and inserted=false on duplicate", async () => {
    const store = new InMemoryEasyPostWebhookEventStore();
    const first = await store.recordReceived({
      event: event(),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    const second = await store.recordReceived({
      event: event(),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it("recordReceived sets processedAt for IGNORED rows", async () => {
    const store = new InMemoryEasyPostWebhookEventStore();
    const result = await store.recordReceived({
      event: event("evt_ignored_1"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "IGNORED",
    });
    expect(result.inserted).toBe(true);
    expect(result.record.status).toBe("IGNORED");
    expect(result.record.processedAt).toEqual(NOW);
  });

  it("markProcessing bumps attempts and sets processingStartedAt", async () => {
    const store = new InMemoryEasyPostWebhookEventStore();
    await store.recordReceived({
      event: event("evt_proc_1"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    const processing = await store.markProcessing("evt_proc_1", NOW);
    expect(processing.status).toBe("PROCESSING");
    expect(processing.attempts).toBe(1);
    expect(processing.processingStartedAt).toEqual(NOW);
  });

  it("markSucceeded clears lastError and nextAttemptAt", async () => {
    const store = new InMemoryEasyPostWebhookEventStore();
    await store.recordReceived({
      event: event("evt_succ_1"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    await store.markFailed({
      externalEventId: "evt_succ_1",
      failedAt: NOW,
      errorMessage: "transient",
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    const result = await store.markSucceeded("evt_succ_1", NOW);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.lastError).toBeNull();
    expect(result.nextAttemptAt).toBeNull();
  });

  it("markFailed records lastError and nextAttemptAt", async () => {
    const store = new InMemoryEasyPostWebhookEventStore();
    await store.recordReceived({
      event: event("evt_fail_1"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    const nextAttempt = new Date(NOW.getTime() + 60_000);
    const result = await store.markFailed({
      externalEventId: "evt_fail_1",
      failedAt: NOW,
      errorMessage: "downstream 503",
      nextAttemptAt: nextAttempt,
    });
    expect(result.status).toBe("FAILED");
    expect(result.lastError).toBe("downstream 503");
    expect(result.nextAttemptAt).toEqual(nextAttempt);
  });

  it("findByExternalEventId returns null for unknown ids", async () => {
    const store = new InMemoryEasyPostWebhookEventStore();
    expect(await store.findByExternalEventId("missing")).toBeNull();
  });
});
