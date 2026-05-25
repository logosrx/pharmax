import { ShippingProvider } from "@pharmax/database";
import { afterEach, describe, expect, it } from "vitest";

import type { ShippingAdapter } from "./carriers/shipping-adapter.js";
import {
  configureShipping,
  getShippingAdapterFactory,
  getShippingConfiguration,
  resetShippingConfigurationForTests,
  type CarrierCredentialContext,
} from "./configure.js";

const STUB_ADAPTER: ShippingAdapter = {
  providerName: "stub",
  purchaseLabel: async () => ({
    carrier: "USPS" as never,
    serviceLevel: "Priority",
    trackingNumber: "0",
    externalShipmentId: "0",
    externalTrackerId: null,
    labelUrl: null,
    labelPdfBase64: null,
    postageRateCents: null,
  }),
};

afterEach(() => {
  resetShippingConfigurationForTests();
});

describe("configureShipping", () => {
  it("throws SHIPPING_NOT_CONFIGURED when read without configuration", () => {
    expect(() => getShippingConfiguration()).toThrowError(/@pharmax\/shipping is not configured/);
  });

  it("returns the registered factory for the provider", () => {
    const seen: CarrierCredentialContext[] = [];
    configureShipping({
      factories: {
        [ShippingProvider.EASYPOST]: (ctx) => {
          seen.push(ctx);
          return STUB_ADAPTER;
        },
      },
    });

    const factory = getShippingAdapterFactory(ShippingProvider.EASYPOST);
    const adapter = factory({
      organizationId: "org-1",
      credentialId: "cred-1",
      apiKey: "key",
      webhookSecret: null,
      carrierAccountId: null,
      baseUrl: null,
    });

    expect(adapter).toBe(STUB_ADAPTER);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.apiKey).toBe("key");
  });

  it("throws SHIPPING_PROVIDER_NOT_REGISTERED for unregistered providers", () => {
    configureShipping({
      factories: { [ShippingProvider.EASYPOST]: () => STUB_ADAPTER },
    });
    expect(() => getShippingAdapterFactory(ShippingProvider.FEDEX)).toThrowError(
      /No ShippingAdapter factory is registered/
    );
  });

  it("calling configureShipping again replaces the registry", () => {
    configureShipping({
      factories: { [ShippingProvider.EASYPOST]: () => STUB_ADAPTER },
    });
    configureShipping({
      factories: { [ShippingProvider.FEDEX]: () => STUB_ADAPTER },
    });
    expect(() => getShippingAdapterFactory(ShippingProvider.EASYPOST)).toThrowError(
      /No ShippingAdapter factory is registered/
    );
    expect(getShippingAdapterFactory(ShippingProvider.FEDEX)).toBeTypeOf("function");
  });
});
