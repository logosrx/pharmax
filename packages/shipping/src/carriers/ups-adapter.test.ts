import { ShipmentCarrier } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import { UpsClient } from "./ups-client.js";
import { UpsShippingAdapter } from "./ups-adapter.js";
import type { PurchaseLabelInput } from "./shipping-adapter.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function upsClient(
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

const VALID_INPUT: PurchaseLabelInput = {
  fromAddress: {
    name: "Pharmax",
    street1: "1 Pharmacy Way",
    city: "Brooklyn",
    state: "NY",
    postalCode: "11201",
    country: "US",
  },
  toAddress: {
    name: "Recipient",
    street1: "100 Sample St",
    city: "Brooklyn",
    state: "NY",
    postalCode: "11201",
    country: "US",
  },
  parcel: { lengthInches: 6, widthInches: 4, heightInches: 2, weightOunces: 16 },
  carrier: ShipmentCarrier.UPS,
  serviceLevel: "ground",
};

describe("UpsShippingAdapter.purchaseLabel", () => {
  it("authenticates, ships, and returns the tracking number + postage cents", async () => {
    const client = upsClient((url) => {
      if (url.endsWith("/security/v1/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/api/shipments/v2403/ship")) {
        return jsonResponse({
          ShipmentResponse: {
            Response: { ResponseStatus: { Code: "1", Description: "Success" } },
            ShipmentResults: {
              ShipmentIdentificationNumber: "1Z9999999999999998",
              ShipmentCharges: {
                TotalCharges: { MonetaryValue: "13.42", CurrencyCode: "USD" },
              },
              PackageResults: {
                TrackingNumber: "1Z9999999999999999",
                ShippingLabel: { GraphicImage: "BASE64...", ImageFormat: { Code: "PNG" } },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new UpsShippingAdapter({ client });

    const result = await adapter.purchaseLabel(VALID_INPUT);

    expect(result).toMatchObject({
      carrier: ShipmentCarrier.UPS,
      serviceLevel: "03",
      trackingNumber: "1Z9999999999999999",
      externalShipmentId: "1Z9999999999999998",
      externalTrackerId: null,
      labelUrl: null,
      postageRateCents: 1342,
    });
  });

  it("wraps a ship-call failure as UPS_SHIP_FAILED", async () => {
    const client = upsClient((url) => {
      if (url.endsWith("/security/v1/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/api/shipments/v2403/ship")) {
        return jsonResponse(
          {
            response: {
              errors: [{ code: "120100", message: "Missing or invalid shipper number" }],
            },
          },
          400
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new UpsShippingAdapter({ client });
    await expect(adapter.purchaseLabel(VALID_INPUT)).rejects.toMatchObject({
      code: "UPS_SHIP_FAILED",
    });
  });

  it("refuses to fulfill a carrier other than UPS or OTHER", async () => {
    const client = upsClient(() => jsonResponse(TOKEN_RESPONSE));
    const adapter = new UpsShippingAdapter({ client });
    await expect(
      adapter.purchaseLabel({ ...VALID_INPUT, carrier: ShipmentCarrier.FEDEX })
    ).rejects.toMatchObject({ code: "UPS_CARRIER_MISMATCH" });
  });
});
