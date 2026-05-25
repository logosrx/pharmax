import { ShipmentCarrier } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import { FedExClient } from "./fedex-client.js";
import { FedExShippingAdapter } from "./fedex-adapter.js";
import type { PurchaseLabelInput } from "./shipping-adapter.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fedexClient(
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

const VALID_INPUT: PurchaseLabelInput = {
  fromAddress: {
    name: "Pharmax",
    street1: "1 Pharmacy Way",
    city: "Brooklyn",
    state: "NY",
    postalCode: "11201",
    country: "US",
    phone: "(212) 555-1234",
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
  carrier: ShipmentCarrier.FEDEX,
  serviceLevel: "ground",
};

describe("FedExShippingAdapter.purchaseLabel", () => {
  it("ships directly (no rate-quote round trip) and returns base64 label + tracking", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    const client = fedexClient((url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments")) {
        captured.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse({
          output: {
            transactionShipments: [
              {
                masterTrackingNumber: "794665654567",
                serviceType: "FEDEX_GROUND",
                serviceName: "FedEx Ground",
                pieceResponses: [
                  {
                    trackingNumber: "794665654567",
                    packageDocuments: [
                      {
                        encodedLabel: "BASE64_PDF_PAYLOAD",
                        contentType: "application/pdf",
                      },
                    ],
                  },
                ],
                shipmentRating: {
                  shipmentRateDetails: [{ totalNetCharge: 12.5, currency: "USD" }],
                },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new FedExShippingAdapter({ client });

    const result = await adapter.purchaseLabel(VALID_INPUT);

    expect(result).toMatchObject({
      carrier: ShipmentCarrier.FEDEX,
      serviceLevel: "FedEx Ground",
      trackingNumber: "794665654567",
      externalShipmentId: "794665654567",
      externalTrackerId: null,
      labelUrl: null,
      labelPdfBase64: "BASE64_PDF_PAYLOAD",
      postageRateCents: 1250,
    });

    // Adapter sent only ONE call — no rate-quote pre-roundtrip.
    expect(captured).toHaveLength(1);
    const shipBody = captured[0]!.body as {
      labelResponseOptions: string;
      requestedShipment: {
        serviceType: string;
        pickupType: string;
        shipDatestamp: string;
        labelSpecification: { labelStockType: string; labelFormatType: string; imageType: string };
        shipper: { contact: { phoneNumber?: string } };
      };
    };
    expect(shipBody.labelResponseOptions).toBe("LABEL");
    expect(shipBody.requestedShipment.serviceType).toBe("FEDEX_GROUND");
    expect(shipBody.requestedShipment.pickupType).toBe("DROPOFF_AT_FEDEX_LOCATION");
    expect(shipBody.requestedShipment.labelSpecification.imageType).toBe("PDF");
    expect(shipBody.requestedShipment.labelSpecification.labelStockType).toBe("PAPER_4X6");
    expect(shipBody.requestedShipment.labelSpecification.labelFormatType).toBe("COMMON2D");
    // YYYY-MM-DD per the EONPRO contract.
    expect(shipBody.requestedShipment.shipDatestamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Phone digits-only normalization.
    expect(shipBody.requestedShipment.shipper.contact.phoneNumber).toBe("2125551234");
  });

  it("wraps a ship-call failure as FEDEX_SHIP_FAILED", async () => {
    const client = fedexClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments")) {
        return jsonResponse({ errors: [{ code: "INVALID.RECIPIENT", message: "bad zip" }] }, 422);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new FedExShippingAdapter({ client });
    await expect(adapter.purchaseLabel(VALID_INPUT)).rejects.toMatchObject({
      code: "FEDEX_SHIP_FAILED",
    });
  });

  it("refuses to fulfill a carrier other than FEDEX or OTHER", async () => {
    const client = fedexClient(() => jsonResponse(TOKEN_RESPONSE));
    const adapter = new FedExShippingAdapter({ client });
    await expect(
      adapter.purchaseLabel({ ...VALID_INPUT, carrier: ShipmentCarrier.USPS })
    ).rejects.toMatchObject({ code: "FEDEX_CARRIER_MISMATCH" });
  });

  it("falls back to shipmentDocuments.encodedLabel when pieceResponses lacks one", async () => {
    const client = fedexClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments")) {
        return jsonResponse({
          output: {
            transactionShipments: [
              {
                masterTrackingNumber: "794665654568",
                serviceType: "FEDEX_GROUND",
                pieceResponses: [{ trackingNumber: "794665654568" }],
                shipmentDocuments: [{ encodedLabel: "SHIPMENT_DOC_BASE64" }],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new FedExShippingAdapter({ client });
    const result = await adapter.purchaseLabel(VALID_INPUT);
    expect(result.labelPdfBase64).toBe("SHIPMENT_DOC_BASE64");
  });
});

describe("FedExShippingAdapter.cancelLabel", () => {
  it("cancels via PUT /ship/v1/shipments/cancel and reports providerConfirmationId", async () => {
    const client = fedexClient((url, init) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments/cancel")) {
        expect(init.method).toBe("PUT");
        return jsonResponse({
          output: { cancelledShipment: true, message: "Cancellation accepted" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new FedExShippingAdapter({ client });
    const result = await adapter.cancelLabel!({ trackingNumber: "794665654567" });
    expect(result).toEqual({ cancelled: true, providerConfirmationId: "Cancellation accepted" });
  });

  it("treats a 4xx 'not found / already cancelled' as idempotent success", async () => {
    const client = fedexClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments/cancel")) {
        return jsonResponse(
          { errors: [{ code: "SHIPMENT.NOT_FOUND", message: "not cancellable" }] },
          404
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new FedExShippingAdapter({ client });
    const result = await adapter.cancelLabel!({ trackingNumber: "794665654567" });
    expect(result.cancelled).toBe(true);
  });

  it("propagates 5xx failures as FEDEX_CANCEL_FAILED", async () => {
    const client = fedexClient((url) => {
      if (url.endsWith("/oauth/token")) return jsonResponse(TOKEN_RESPONSE);
      if (url.endsWith("/ship/v1/shipments/cancel")) {
        return jsonResponse({ errors: [{ code: "INTERNAL", message: "boom" }] }, 500);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new FedExShippingAdapter({ client });
    await expect(adapter.cancelLabel!({ trackingNumber: "794665654567" })).rejects.toMatchObject({
      code: "FEDEX_CANCEL_FAILED",
    });
  });
});
