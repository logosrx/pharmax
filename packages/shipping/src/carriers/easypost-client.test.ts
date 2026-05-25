import { describe, expect, it, vi } from "vitest";

import { EasyPostApiError, EasyPostClient, type EasyPostShipment } from "./easypost-client.js";

const API_KEY = "EZTK_test_key";

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {})
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("EasyPostClient", () => {
  it("attaches HTTP Basic auth with the api key as username", async () => {
    let capturedInit: RequestInit = {};
    const fetchImpl = fakeFetch((_url, init) => {
      capturedInit = init;
      return jsonResponse({ id: "shp_1", rates: [] } satisfies EasyPostShipment);
    });

    const client = new EasyPostClient({ apiKey: API_KEY, fetch: fetchImpl });
    await client.createShipment({
      shipment: {
        from_address: {
          name: "F",
          street1: "1",
          city: "C",
          state: "CA",
          zip: "94000",
          country: "US",
        },
        to_address: {
          name: "T",
          street1: "1",
          city: "C",
          state: "CA",
          zip: "94000",
          country: "US",
        },
        parcel: { length: 1, width: 1, height: 1, weight: 1 },
      },
    });

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from(`${API_KEY}:`, "utf8").toString("base64")}`
    );
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("returns the parsed JSON body on success", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({
        id: "shp_2",
        rates: [
          { id: "rate_1", carrier: "USPS", service: "Priority", rate: "9.40", currency: "USD" },
        ],
      })
    );
    const client = new EasyPostClient({ apiKey: API_KEY, fetch: fetchImpl });
    const result = await client.createShipment({
      shipment: {
        from_address: {
          name: "F",
          street1: "1",
          city: "C",
          state: "CA",
          zip: "94000",
          country: "US",
        },
        to_address: {
          name: "T",
          street1: "1",
          city: "C",
          state: "CA",
          zip: "94000",
          country: "US",
        },
        parcel: { length: 1, width: 1, height: 1, weight: 1 },
      },
    });
    expect(result.id).toBe("shp_2");
    expect(result.rates).toHaveLength(1);
  });

  it("maps provider error payloads into EasyPostApiError with code + message", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ error: { code: "ADDRESS.VERIFY.FAILURE", message: "Invalid zip" } }, 422)
    );
    const client = new EasyPostClient({ apiKey: API_KEY, fetch: fetchImpl });
    await expect(client.buyShipment("shp_3", { rate: { id: "rate_1" } })).rejects.toMatchObject({
      name: "EasyPostApiError",
      code: "ADDRESS.VERIFY.FAILURE",
      httpStatus: 422,
      providerErrorCode: "ADDRESS.VERIFY.FAILURE",
    });
  });

  it("falls back to a synthetic code when the provider omits error.code", async () => {
    const fetchImpl = fakeFetch(() => new Response("oops", { status: 500 }));
    const client = new EasyPostClient({ apiKey: API_KEY, fetch: fetchImpl });
    await expect(client.buyShipment("shp_4", { rate: { id: "rate_1" } })).rejects.toMatchObject({
      code: "EASYPOST_RESPONSE_INVALID_JSON",
      httpStatus: 500,
    });
  });

  it("rejects an empty api key at construction", () => {
    expect(() => new EasyPostClient({ apiKey: "" })).toThrowError(/non-empty apiKey/);
  });

  it("rejects buyShipment with an empty shipment id", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: "noop", rates: [] }));
    const client = new EasyPostClient({ apiKey: API_KEY, fetch: fetchImpl });
    await expect(client.buyShipment("", { rate: { id: "r" } })).rejects.toThrowError(
      /non-empty shipmentId/
    );
  });

  it("wraps a network error in EasyPostApiError with code EASYPOST_REQUEST_FAILED", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const client = new EasyPostClient({ apiKey: API_KEY, fetch: fetchImpl });
    await expect(
      client.createShipment({
        shipment: {
          from_address: {
            name: "F",
            street1: "1",
            city: "C",
            state: "CA",
            zip: "94000",
            country: "US",
          },
          to_address: {
            name: "T",
            street1: "1",
            city: "C",
            state: "CA",
            zip: "94000",
            country: "US",
          },
          parcel: { length: 1, width: 1, height: 1, weight: 1 },
        },
      })
    ).rejects.toBeInstanceOf(EasyPostApiError);
  });
});
