import { describe, expect, it, vi } from "vitest";

import { UpsApiError, UpsClient } from "./ups-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildClient(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): UpsClient {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {})
  ) as unknown as typeof fetch;
  return new UpsClient({
    apiKey: "ups_client_id",
    apiSecret: "ups_client_secret",
    shipperNumber: "AB1234",
    fetch: fetchImpl,
  });
}

const TOKEN_RESPONSE = {
  access_token: "ups_access_token",
  expires_in: "14400",
  token_type: "Bearer",
};

const PACKAGE_FIXTURE = {
  trackingNumber: "1Z999AA10123456784",
  currentStatus: { type: "I", description: "In Transit" },
  activity: [
    {
      date: "20260524",
      time: "143000",
      status: { type: "I", description: "Departed UPS Facility", code: "PD" },
      location: { address: { city: "Louisville", stateProvince: "KY", country: "US" } },
    },
  ],
};

function buildTrackResponse(pkg: typeof PACKAGE_FIXTURE = PACKAGE_FIXTURE): {
  trackResponse: { shipment: Array<{ package: Array<typeof PACKAGE_FIXTURE> }> };
} {
  return { trackResponse: { shipment: [{ package: [pkg] }] } };
}

describe("UpsClient.trackShipment", () => {
  it("GETs the v1 track details endpoint with the bearer token", async () => {
    let capturedAuth = "";
    let capturedUrl = "";
    let capturedMethod = "";
    const client = buildClient((url, init) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse(TOKEN_RESPONSE);
      }
      if (url.includes("/api/track/v1/details/")) {
        capturedUrl = url;
        capturedMethod = init.method ?? "";
        capturedAuth = String(
          (init.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
        );
        return jsonResponse(buildTrackResponse());
      }
      throw new Error(`unexpected: ${url}`);
    });

    const response = await client.trackShipment("1Z999AA10123456784");
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("/api/track/v1/details/1Z999AA10123456784");
    expect(capturedAuth).toBe("Bearer ups_access_token");
    expect(response.trackResponse.shipment[0]?.package[0]?.trackingNumber).toBe(
      "1Z999AA10123456784"
    );
  });

  it("throws UpsApiError on 4xx responses", async () => {
    const client = buildClient((url) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse(TOKEN_RESPONSE);
      }
      return new Response(
        JSON.stringify({
          response: { errors: [{ code: "151018", message: "Invalid tracking number." }] },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    });
    await expect(client.trackShipment("invalid")).rejects.toBeInstanceOf(UpsApiError);
  });
});

describe("UpsClient.trackShipmentBatch", () => {
  it("returns a result entry per requested tracking number", async () => {
    const client = buildClient((url) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse(TOKEN_RESPONSE);
      }
      return jsonResponse(buildTrackResponse());
    });

    const batch = await client.trackShipmentBatch(["1Z999AA10123456784", "1Z999AA10123456785"]);
    expect(batch.results).toHaveLength(2);
    expect(batch.results[0]?.error).toBeNull();
    expect(batch.results[0]?.package?.currentStatus?.type).toBe("I");
  });

  it("isolates per-tracking-number errors without aborting the batch", async () => {
    let call = 0;
    const client = buildClient((url) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse(TOKEN_RESPONSE);
      }
      call += 1;
      if (call === 1) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse(buildTrackResponse());
    });

    const batch = await client.trackShipmentBatch(["1Z999AA10123456784", "1Z999AA10123456785"]);
    expect(batch.results[0]?.package).toBeNull();
    expect(batch.results[0]?.error).toBeInstanceOf(UpsApiError);
    expect(batch.results[1]?.error).toBeNull();
    expect(batch.results[1]?.package?.trackingNumber).toBe("1Z999AA10123456784");
  });
});
