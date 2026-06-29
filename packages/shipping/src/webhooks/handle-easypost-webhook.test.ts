import { createHmac } from "node:crypto";

import { logger as loggerNs } from "@pharmax/platform-core";
import { beforeEach, describe, expect, it } from "vitest";

import { handleEasyPostWebhook } from "./handle-easypost-webhook.js";
import { InMemoryEasyPostWebhookEventStore } from "./in-memory-event-store.js";

const TEST_SECRET = "test_easypost_webhook_secret";

function trackerBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_test_1",
    description: "tracker.updated",
    result: {
      id: "trk_xyz",
      tracking_code: "9400111899223344556677",
      status: "in_transit",
      updated_at: "2026-05-24T18:00:00Z",
      carrier: "USPS",
    },
    ...overrides,
  });
}

function sign(body: string): string {
  return createHmac("sha256", TEST_SECRET).update(body, "utf8").digest("hex");
}

describe("handleEasyPostWebhook", () => {
  let eventStore: InMemoryEasyPostWebhookEventStore;

  beforeEach(() => {
    eventStore = new InMemoryEasyPostWebhookEventStore();
  });

  it("returns missing_signature when the header is absent", async () => {
    const result = await handleEasyPostWebhook(
      { rawBody: trackerBody(), signatureHeader: null },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result).toMatchObject({ status: "missing_signature", httpStatus: 400 });
  });

  it("returns invalid_signature when the secret does not match", async () => {
    const body = trackerBody();
    const result = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: "a".repeat(64) },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result).toMatchObject({ status: "invalid_signature", httpStatus: 400 });
  });

  it("accepts a tracker event and writes a PENDING ledger row", async () => {
    const body = trackerBody();
    const result = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: sign(body) },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result.status).toBe("accepted");
    expect(result.httpStatus).toBe(200);
    if (result.status === "accepted") {
      expect(result.record.status).toBe("PENDING");
      expect(result.record.attempts).toBe(0);
      expect(result.record.trackingCode).toBe("9400111899223344556677");
      expect(result.record.carrierStatus).toBe("in_transit");
    }
  });

  it("does NOT persist recipient PHI present on the inbound body (B-5 projection)", async () => {
    // EasyPost bodies can carry recipient name/address. The parse
    // schema is `.passthrough()`, so these survive parsing — but the
    // ingestion path must project the payload down to the PHI-free
    // replay subset before persisting it to the ledger row.
    const body = trackerBody({
      // Top-level PHI-adjacent extras EasyPost may include.
      to_address: { name: "Jordan Patient", street1: "123 Real St", zip: "90210" },
      result: {
        id: "trk_phi",
        tracking_code: "9400111899223344556677",
        status: "in_transit",
        updated_at: "2026-05-24T18:00:00Z",
        carrier: "USPS",
        // PHI nested inside result.
        recipient_name: "Jordan Patient",
        to_address: { name: "Jordan Patient", street1: "123 Real St", zip: "90210" },
      },
    });
    const result = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: sign(body) },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      const stored = result.record.payload as Record<string, unknown>;
      const storedResult = stored.result as Record<string, unknown>;
      // Replay-critical fields are retained.
      expect(storedResult.tracking_code).toBe("9400111899223344556677");
      expect(storedResult.status).toBe("in_transit");
      expect(storedResult.updated_at).toBe("2026-05-24T18:00:00Z");
      expect(storedResult.carrier).toBe("USPS");
      // PHI / unknown extras are dropped, top-level and nested.
      expect(stored.to_address).toBeUndefined();
      expect(storedResult.recipient_name).toBeUndefined();
      expect(storedResult.to_address).toBeUndefined();
      // Serialized form carries no recipient string anywhere.
      expect(JSON.stringify(stored)).not.toContain("Jordan Patient");
      expect(JSON.stringify(stored)).not.toContain("123 Real St");
    }
  });

  it("returns duplicate on a redelivered event", async () => {
    const body = trackerBody({ id: "evt_dup_1" });
    const deps = { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger };
    const first = await handleEasyPostWebhook({ rawBody: body, signatureHeader: sign(body) }, deps);
    const second = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: sign(body) },
      deps
    );
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    if (first.status === "accepted" && second.status === "duplicate") {
      expect(second.record.id).toBe(first.record.id);
    }
  });

  it("marks non-tracker events as IGNORED on first delivery", async () => {
    const body = JSON.stringify({
      id: "evt_scan_form_1",
      description: "scan_form.created",
      result: {},
    });
    const result = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: sign(body) },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result.status).toBe("ignored");
    expect(result.httpStatus).toBe(200);
    if (result.status === "ignored") {
      expect(result.record.status).toBe("IGNORED");
      expect(result.record.processedAt).not.toBeNull();
    }
  });

  it("returns malformed_body with 200 for non-JSON payloads (so EasyPost stops retrying)", async () => {
    const body = "not-json";
    const result = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: sign(body) },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result.status).toBe("malformed_body");
    expect(result.httpStatus).toBe(200);
  });

  it("returns malformed_body with 200 for a tracker event with a missing required field", async () => {
    const body = JSON.stringify({
      id: "evt_missing_1",
      description: "tracker.updated",
      result: { id: "trk_xyz" },
    });
    const result = await handleEasyPostWebhook(
      { rawBody: body, signatureHeader: sign(body) },
      { eventStore, webhookSecret: TEST_SECRET, logger: loggerNs.noopLogger }
    );
    expect(result).toMatchObject({ status: "malformed_body", httpStatus: 200 });
  });
});
