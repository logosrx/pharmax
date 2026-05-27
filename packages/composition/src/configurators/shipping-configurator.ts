// Shipping Configurator.
//
// Wires per-provider adapter factories into `@pharmax/shipping`.
// Crypto must already be configured because the first dispatch
// through `PurchaseShipmentLabel` or `RecordShipmentTrackingEvent`
// triggers `resolveShippingAdapter`, which decrypts the per-org
// carrier credential before invoking the registered factory.

import { configureShipping, type ShippingConfiguration } from "@pharmax/shipping";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { Configurator } from "../types.js";

export function createShippingConfigurator(config: ShippingConfiguration): Configurator {
  return Object.freeze({
    name: "@pharmax/shipping",
    priority: BUILT_IN_PRIORITIES.SHIPPING,
    apply(): void {
      configureShipping(config);
    },
  });
}
