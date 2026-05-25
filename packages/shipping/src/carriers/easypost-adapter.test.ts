import { ShipmentCarrier } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import { EasyPostClient, type EasyPostShipment } from "./easypost-client.js";
import { EasyPostShippingAdapter } from "./easypost-adapter.js";
import type { PurchaseLabelInput } from "./shipping-adapter.js";

function makeClient(handler: (url: string, init: RequestInit) => Response): EasyPostClient {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {})
  ) as unknown as typeof fetch;
  return new EasyPostClient({ apiKey: "EZTK_test_key", fetch: fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PURCHASE_INPUT: PurchaseLabelInput = {
  fromAddress: {
    name: "Pharmax Outbound",
    street1: "1 Pharmacy Way",
    city: "Brooklyn",
    state: "NY",
    postalCode: "11201",
    country: "US",
  },
  toAddress: {
    name: "Recipient Demo",
    street1: "100 Sample St",
    city: "Brooklyn",
    state: "NY",
    postalCode: "11201",
    country: "US",
  },
  parcel: { lengthInches: 6, widthInches: 4, heightInches: 2, weightOunces: 8 },
  carrier: ShipmentCarrier.USPS,
  serviceLevel: "Priority",
};

const RATE_PRIORITY: EasyPostShipment["rates"][number] = {
  id: "rate_priority",
  carrier: "USPS",
  service: "Priority",
  rate: "9.40",
  currency: "USD",
};

const RATE_EXPRESS: EasyPostShipment["rates"][number] = {
  id: "rate_express",
  carrier: "USPS",
  service: "Express",
  rate: "29.00",
  currency: "USD",
};

const RATE_UPS: EasyPostShipment["rates"][number] = {
  id: "rate_ups_ground",
  carrier: "UPS",
  service: "Ground",
  rate: "12.00",
  currency: "USD",
};

describe("EasyPostShippingAdapter.purchaseLabel", () => {
  it("creates a shipment, picks the matching rate, and returns the bought label", async () => {
    const client = makeClient((url) => {
      if (url.endsWith("/v2/shipments")) {
        return jsonResponse({
          id: "shp_demo",
          rates: [RATE_PRIORITY, RATE_EXPRESS],
        } satisfies EasyPostShipment);
      }
      if (url.endsWith("/v2/shipments/shp_demo/buy")) {
        return jsonResponse({
          id: "shp_demo",
          rates: [RATE_PRIORITY],
          tracking_code: "9400111899223344556677",
          tracker: { id: "trk_demo" },
          postage_label: { label_url: "https://example.invalid/label.png" },
          selected_rate: RATE_PRIORITY,
        } satisfies EasyPostShipment);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new EasyPostShippingAdapter({ client });

    const result = await adapter.purchaseLabel(PURCHASE_INPUT);

    expect(result).toMatchObject({
      carrier: ShipmentCarrier.USPS,
      serviceLevel: "Priority",
      trackingNumber: "9400111899223344556677",
      externalShipmentId: "shp_demo",
      externalTrackerId: "trk_demo",
      labelUrl: "https://example.invalid/label.png",
      postageRateCents: 940,
    });
  });

  it("picks the cheapest matching rate when multiple carriers offer the requested service", async () => {
    const cheaperUsps = { ...RATE_PRIORITY, id: "rate_priority_cheap", rate: "8.20" };
    const client = makeClient((url) => {
      if (url.endsWith("/v2/shipments")) {
        return jsonResponse({
          id: "shp_multi",
          rates: [RATE_PRIORITY, cheaperUsps],
        });
      }
      if (url.endsWith("/v2/shipments/shp_multi/buy")) {
        return jsonResponse({
          id: "shp_multi",
          rates: [cheaperUsps],
          tracking_code: "T1",
          tracker: { id: "trk_multi" },
          selected_rate: cheaperUsps,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new EasyPostShippingAdapter({ client });

    const result = await adapter.purchaseLabel(PURCHASE_INPUT);
    expect(result.postageRateCents).toBe(820);
  });

  it("rejects when no rate matches the requested carrier", async () => {
    const client = makeClient((url) => {
      if (url.endsWith("/v2/shipments")) {
        return jsonResponse({ id: "shp_x", rates: [RATE_UPS] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new EasyPostShippingAdapter({ client });

    await expect(adapter.purchaseLabel(PURCHASE_INPUT)).rejects.toMatchObject({
      code: "EASYPOST_NO_MATCHING_RATE",
    });
  });

  it("wraps a buy failure into EASYPOST_BUY_SHIPMENT_FAILED", async () => {
    const client = makeClient((url) => {
      if (url.endsWith("/v2/shipments")) {
        return jsonResponse({ id: "shp_b", rates: [RATE_PRIORITY] });
      }
      if (url.endsWith("/v2/shipments/shp_b/buy")) {
        return jsonResponse({ error: { code: "PAYMENT.DECLINED", message: "card declined" } }, 402);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new EasyPostShippingAdapter({ client });

    await expect(adapter.purchaseLabel(PURCHASE_INPUT)).rejects.toMatchObject({
      code: "EASYPOST_BUY_SHIPMENT_FAILED",
    });
  });

  it("throws EASYPOST_NO_TRACKING_CODE when the bought shipment lacks a tracking_code", async () => {
    const client = makeClient((url) => {
      if (url.endsWith("/v2/shipments")) {
        return jsonResponse({ id: "shp_n", rates: [RATE_PRIORITY] });
      }
      if (url.endsWith("/v2/shipments/shp_n/buy")) {
        return jsonResponse({ id: "shp_n", rates: [RATE_PRIORITY], selected_rate: RATE_PRIORITY });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new EasyPostShippingAdapter({ client });

    await expect(adapter.purchaseLabel(PURCHASE_INPUT)).rejects.toMatchObject({
      code: "EASYPOST_NO_TRACKING_CODE",
    });
  });

  it("accepts any matching carrier when input.carrier is OTHER", async () => {
    const client = makeClient((url) => {
      if (url.endsWith("/v2/shipments")) {
        return jsonResponse({ id: "shp_o", rates: [RATE_UPS] });
      }
      if (url.endsWith("/v2/shipments/shp_o/buy")) {
        return jsonResponse({
          id: "shp_o",
          rates: [RATE_UPS],
          tracking_code: "1Z9999999999999999",
          tracker: { id: "trk_o" },
          selected_rate: RATE_UPS,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new EasyPostShippingAdapter({ client });

    const result = await adapter.purchaseLabel({
      ...PURCHASE_INPUT,
      carrier: ShipmentCarrier.OTHER,
      serviceLevel: "Ground",
    });
    expect(result.carrier).toBe(ShipmentCarrier.UPS);
    expect(result.trackingNumber).toBe("1Z9999999999999999");
  });
});
