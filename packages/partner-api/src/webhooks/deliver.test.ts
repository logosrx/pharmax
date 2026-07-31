import { describe, expect, it } from "vitest";

import { attemptWebhookDelivery, webhookSecretBinding, WEBHOOK_USER_AGENT } from "./deliver.js";
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "./signature.js";

const SECRET = "pxw_test-secret-for-delivery-unit-tests-0000000";

function captureFetch(status: number): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("attemptWebhookDelivery", () => {
  it("POSTs a signed envelope the reference verifier accepts", async () => {
    const { fetchImpl, calls } = captureFetch(200);
    const nowMs = 1_800_000_000_000;

    const result = await attemptWebhookDelivery({
      url: "https://partner.example/hooks",
      secret: SECRET,
      deliveryId: "d-1",
      eventType: "platform.api_key.created.v1",
      payload: { hello: "world" },
      occurredAt: new Date("2026-07-24T12:00:00.000Z"),
      fetchImpl,
      nowMs,
    });

    expect(result).toEqual({ ok: true, responseStatus: 200 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.url).toBe("https://partner.example/hooks");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(WEBHOOK_USER_AGENT);
    expect(headers["pharmax-delivery-id"]).toBe("d-1");
    expect(headers["pharmax-event-type"]).toBe("platform.api_key.created.v1");

    const body = String(call.init.body);
    const envelope = JSON.parse(body) as Record<string, unknown>;
    expect(envelope["id"]).toBe("d-1");
    expect(envelope["type"]).toBe("platform.api_key.created.v1");
    expect(envelope["occurredAt"]).toBe("2026-07-24T12:00:00.000Z");
    expect(envelope["data"]).toEqual({ hello: "world" });

    // The signature over the EXACT body must verify with our own
    // reference verifier — this is the contract partners code to.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: headers[WEBHOOK_SIGNATURE_HEADER] ?? "",
        body,
        nowSeconds: Math.floor(nowMs / 1000),
      })
    ).toBe(true);
  });

  it("classifies non-2xx responses as failures with the status", async () => {
    const { fetchImpl } = captureFetch(503);
    const result = await attemptWebhookDelivery({
      url: "https://partner.example/hooks",
      secret: SECRET,
      deliveryId: "d-2",
      eventType: "platform.api_key.created.v1",
      payload: {},
      occurredAt: new Date(),
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.responseStatus).toBe(503);
  });

  it("classifies transport errors as failures with a null status and NO response-body echo", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await attemptWebhookDelivery({
      url: "https://partner.example/hooks",
      secret: SECRET,
      deliveryId: "d-3",
      eventType: "platform.api_key.created.v1",
      payload: {},
      occurredAt: new Date(),
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.responseStatus).toBeNull();
      expect(result.error).toBe("TypeError: fetch failed");
    }
  });
});

describe("webhookSecretBinding", () => {
  it("pins the AAD tuple to (org, webhook_subscription, secret, record)", () => {
    expect(webhookSecretBinding({ organizationId: "org-1", subscriptionId: "sub-1" })).toEqual({
      tenantId: "org-1",
      table: "webhook_subscription",
      column: "secret",
      recordId: "sub-1",
    });
  });
});
