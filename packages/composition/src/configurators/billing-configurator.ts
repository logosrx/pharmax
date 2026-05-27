// Billing Configurator.
//
// Wires the Stripe refund port into `@pharmax/billing`. `null` is a
// valid value (dev/test environments without Stripe creds); the
// `IssueRefund` command surfaces `BILLING_REFUND_NOT_CONFIGURED` in
// that case.

import { configureBilling, type BillingConfiguration } from "@pharmax/billing";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { Configurator } from "../types.js";

export function createBillingConfigurator(config: BillingConfiguration): Configurator {
  return Object.freeze({
    name: "@pharmax/billing",
    priority: BUILT_IN_PRIORITIES.BILLING,
    apply(): void {
      configureBilling(config);
    },
  });
}
