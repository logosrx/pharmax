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
        [ShippingProvider.FEDEX]: (ctx) => {
          seen.push(ctx);
          return STUB_ADAPTER;
        },
      },
    });

    const factory = getShippingAdapterFactory(ShippingProvider.FEDEX);
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
    // Two DISTINCT providers: register one, ask for the other.
    configureShipping({
      factories: { [ShippingProvider.FEDEX]: () => STUB_ADAPTER },
    });
    expect(() => getShippingAdapterFactory(ShippingProvider.UPS)).toThrowError(
      /No ShippingAdapter factory is registered/
    );
  });

  it("calling configureShipping again replaces the registry", () => {
    configureShipping({
      factories: { [ShippingProvider.UPS]: () => STUB_ADAPTER },
    });
    configureShipping({
      factories: { [ShippingProvider.FEDEX]: () => STUB_ADAPTER },
    });
    // The first registration is gone, not merged.
    expect(() => getShippingAdapterFactory(ShippingProvider.UPS)).toThrowError(
      /No ShippingAdapter factory is registered/
    );
    expect(getShippingAdapterFactory(ShippingProvider.FEDEX)).toBeTypeOf("function");
  });

  it("refuses to register a provider with no BAA covering it", () => {
    // The control this file exists to protect. EasyPost is not a
    // conduit — it stored recipient names and addresses in its own
    // platform — and no BAA was ever executed. Registration must fail
    // at boot rather than on the first label purchase, and it must fail
    // even though the provider is still a valid `ShippingProvider`
    // value for historical rows and inbound tracking webhooks.
    expect(() =>
      configureShipping({
        factories: { [ShippingProvider.EASYPOST]: () => STUB_ADAPTER },
      })
    ).toThrowError(/no BAA covers them/);
  });

  it("names every blocked provider in the refusal, not just the first", () => {
    expect(() =>
      configureShipping({
        factories: {
          [ShippingProvider.EASYPOST]: () => STUB_ADAPTER,
          [ShippingProvider.FEDEX]: () => STUB_ADAPTER,
        },
      })
    ).toThrowError(/EASYPOST/);
  });

  it("leaves the previous configuration intact when it refuses", () => {
    // A refused call must not half-apply. If it cleared the box, a bad
    // deploy would take working carriers down with it.
    configureShipping({ factories: { [ShippingProvider.FEDEX]: () => STUB_ADAPTER } });
    expect(() =>
      configureShipping({ factories: { [ShippingProvider.EASYPOST]: () => STUB_ADAPTER } })
    ).toThrow();
    expect(getShippingAdapterFactory(ShippingProvider.FEDEX)).toBeTypeOf("function");
  });
});
