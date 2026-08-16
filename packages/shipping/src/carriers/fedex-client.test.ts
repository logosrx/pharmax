import { describe, expect, it, vi } from "vitest";

import { FedExApiError, FedExClient } from "./fedex-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildClient(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): FedExClient {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {})
  ) as unknown as typeof fetch;
  return new FedExClient({
    apiKey: "fedex_key",
    apiSecret: "fedex_secret",
    accountNumber: "123456789",
    fetch: fetchImpl,
  });
}

const TOKEN_RESPONSE = {
  access_token: "fedex_access_token",
  expires_in: 3600,
  token_type: "Bearer",
};

describe("FedExClient OAuth", () => {
  it("requests an access token with client_credentials grant", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    const client = buildClient((url, init) => {
      if (url.endsWith("/oauth/token")) {
        capturedMethod = init.method ?? "";
        capturedBody = String(init.body ?? "");
        return jsonResponse(TOKEN_RESPONSE);
      }
      throw new Error(`unexpected: ${url}`);
    });
    const token = await client.getAccessToken(new Date("2026-05-24T20:00:00Z"));
    expect(token).toBe("fedex_access_token");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toContain("grant_type=client_credentials");
    expect(capturedBody).toContain("client_id=fedex_key");
    expect(capturedBody).toContain("client_secret=fedex_secret");
  });

  it("caches the token until the safety horizon expires", async () => {
    let callCount = 0;
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) {
        callCount += 1;
        return jsonResponse(TOKEN_RESPONSE);
      }
      throw new Error(`unexpected: ${url}`);
    });
    const now = new Date("2026-05-24T20:00:00Z");
    await client.getAccessToken(now);
    await client.getAccessToken(new Date(now.getTime() + 60_000));
    expect(callCount).toBe(1);
  });

  it("refetches the token once the safety horizon is crossed", async () => {
    let callCount = 0;
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) {
        callCount += 1;
        return jsonResponse({ ...TOKEN_RESPONSE, expires_in: 60 });
      }
      throw new Error(`unexpected: ${url}`);
    });
    const now = new Date("2026-05-24T20:00:00Z");
    await client.getAccessToken(now);
    await client.getAccessToken(new Date(now.getTime() + 60_000));
    expect(callCount).toBe(2);
  });
});

describe("FedExClient request errors", () => {
  it("maps non-JSON error bodies into FedExApiError with FEDEX_RESPONSE_INVALID_JSON", async () => {
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments")) {
        return new Response("internal server error", { status: 502 });
      }
      throw new Error(`unexpected: ${url}`);
    });
    await expect(
      client.createShipment({
        accountNumber: { value: "1" },
        labelResponseOptions: "URL_ONLY",
        requestedShipment: {
          shipper: {
            contact: { personName: "x" },
            address: {
              streetLines: ["x"],
              city: "x",
              stateOrProvinceCode: "x",
              postalCode: "x",
              countryCode: "US",
            },
          },
          recipients: [],
          serviceType: "FEDEX_GROUND",
          packagingType: "YOUR_PACKAGING",
          pickupType: "DROPOFF_AT_FEDEX_LOCATION",
          shippingChargesPayment: {
            paymentType: "SENDER",
            payor: { responsibleParty: { accountNumber: { value: "1" } } },
          },
          labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6" },
          requestedPackageLineItems: [],
        },
      })
    ).rejects.toMatchObject({ code: "FEDEX_RESPONSE_INVALID_JSON", httpStatus: 502 });
  });

  it("preserves provider error code on FedExApiError", async () => {
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments/cancel")) {
        return jsonResponse({ errors: [{ code: "SHIPMENT.NOT_FOUND", message: "n/a" }] }, 404);
      }
      throw new Error(`unexpected: ${url}`);
    });
    await expect(
      client.cancelShipment({ accountNumber: { value: "1" }, trackingNumber: "1" })
    ).rejects.toMatchObject({
      name: "FedExApiError",
      code: "SHIPMENT.NOT_FOUND",
      providerErrorCode: "SHIPMENT.NOT_FOUND",
      httpStatus: 404,
    });
  });
});

describe("FedExClient.trackShipment", () => {
  it("posts a single tracking_number per trackShipment", async () => {
    let body: unknown = null;
    const client = buildClient((url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/track/v1/trackingnumbers")) {
        body = init.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse({
          output: {
            completeTrackResults: [
              {
                trackingNumber: "794665654567",
                trackResults: [
                  {
                    latestStatusDetail: { code: "DL", statusByLocale: "Delivered" },
                  },
                ],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    const result = await client.trackShipment("794665654567");
    expect(result.output.completeTrackResults[0]?.trackResults[0]?.latestStatusDetail?.code).toBe(
      "DL"
    );
    expect(
      (body as { trackingInfo: Array<{ trackingNumberInfo: { trackingNumber: string } }> })
        .trackingInfo[0]?.trackingNumberInfo.trackingNumber
    ).toBe("794665654567");
  });

  it("rejects an empty tracking number", async () => {
    const client = buildClient(() => jsonResponse(TOKEN_RESPONSE));
    await expect(client.trackShipment("")).rejects.toThrowError(/non-empty trackingNumber/);
  });
});

describe("FedExClient.trackShipmentBatch", () => {
  it("returns empty when given no tracking numbers", async () => {
    const client = buildClient(() => jsonResponse(TOKEN_RESPONSE));
    const result = await client.trackShipmentBatch([]);
    expect(result.output.completeTrackResults).toEqual([]);
  });

  it("issues a single call for batches up to 30", async () => {
    let callCount = 0;
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/track/v1/trackingnumbers")) {
        callCount += 1;
        return jsonResponse({ output: { completeTrackResults: [] } });
      }
      throw new Error(`unexpected: ${url}`);
    });
    await client.trackShipmentBatch(Array.from({ length: 30 }, (_, i) => `T${i}`));
    expect(callCount).toBe(1);
  });

  it("chunks batches greater than 30 into multiple calls and merges results", async () => {
    let callCount = 0;
    const client = buildClient((url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/track/v1/trackingnumbers")) {
        const body = init.body
          ? (JSON.parse(String(init.body)) as {
              trackingInfo: Array<{ trackingNumberInfo: { trackingNumber: string } }>;
            })
          : { trackingInfo: [] };
        callCount += 1;
        return jsonResponse({
          output: {
            completeTrackResults: body.trackingInfo.map((info) => ({
              trackingNumber: info.trackingNumberInfo.trackingNumber,
              trackResults: [],
            })),
          },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    const result = await client.trackShipmentBatch(Array.from({ length: 75 }, (_, i) => `T${i}`));
    expect(callCount).toBe(3);
    expect(result.output.completeTrackResults).toHaveLength(75);
  });
});

describe("FedExClient redirect containment", () => {
  // A `baseUrl` that PASSED the write-time host check can still
  // answer 30x, and 307/308 preserve method and body — so following
  // one would re-send the `client_id`/`client_secret` form body to
  // the redirect target and keep `cancelShipment`'s PUT a PUT, which
  // is the method IMDSv2 requires to mint a token.
  const REDIRECT_TARGET = "https://169.254.169.254/latest/api/token";

  const redirectResponse = (status: number): Response =>
    new Response(null, { status, headers: { Location: REDIRECT_TARGET } });

  it("tells the transport never to follow a redirect", async () => {
    const seen: RequestInit[] = [];
    const client = buildClient((url, init) => {
      seen.push(init);
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/track/v1/trackingnumbers")) {
        return jsonResponse({ output: { completeTrackResults: [] } });
      }
      throw new Error(`unexpected: ${url}`);
    });

    await client.trackShipment("794665654567");

    expect(seen).toHaveLength(2);
    for (const init of seen) {
      expect(init.redirect).toBe("error");
    }
  });

  it("refuses a 307 on the token exchange rather than re-sending client_secret", async () => {
    let calls = 0;
    const client = buildClient((url) => {
      calls += 1;
      if (url.endsWith("/oauth/token")) return redirectResponse(307);
      throw new Error(`requested an unscreened host: ${url}`);
    });

    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "FedExApiError",
      code: "FEDEX_UNEXPECTED_REDIRECT",
      httpStatus: 307,
    });
    // Exactly one request: refused where it was received, not chased.
    expect(calls).toBe(1);
  });

  it("refuses a 307 on the cancel PUT", async () => {
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments/cancel")) return redirectResponse(307);
      throw new Error(`requested an unscreened host: ${url}`);
    });

    await expect(
      client.cancelShipment({ accountNumber: { value: "1" }, trackingNumber: "794665654567" })
    ).rejects.toMatchObject({ code: "FEDEX_UNEXPECTED_REDIRECT", httpStatus: 307 });
  });

  it("refuses the whole 3xx range, not only the four redirect statuses", async () => {
    // 300 carries a Location too, and we never send a conditional or
    // proxy-negotiated request — so a 304/305 from a host we do not
    // trust is a protocol violation, not a cache hit.
    for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
      const client = buildClient((url) => {
        if (url.endsWith("/oauth/token")) return redirectResponse(status);
        throw new Error(`requested an unscreened host: ${url}`);
      });
      await expect(client.getAccessToken()).rejects.toMatchObject({
        code: "FEDEX_UNEXPECTED_REDIRECT",
        httpStatus: status,
      });
    }
  });

  it("does not echo the attacker-chosen Location into the error message", async () => {
    const client = buildClient((url) => {
      if (url.endsWith("/oauth/token")) return redirectResponse(302);
      throw new Error(`requested an unscreened host: ${url}`);
    });

    let thrown: unknown;
    try {
      await client.getAccessToken();
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(FedExApiError);
    expect((thrown as Error).message).not.toContain("169.254.169.254");
  });
});

void FedExApiError;
