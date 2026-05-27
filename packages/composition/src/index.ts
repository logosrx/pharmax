// Public surface of @pharmax/composition.
//
// Apps (apps/web, apps/worker, scripts) should import the high-level
// `buildCompositionRoot` plus the `create*Configurator` factories
// from here — NOT the raw `configure*` functions from each package.
// Centralizing the imports means the ordering contract
// (priorities + idempotency cache) is enforced in one place.
//
// Transitional convenience: the raw `configure*` functions are
// re-exported below so existing scripts/tests can migrate
// incrementally. New code should prefer the factories.

export {
  buildCompositionRoot,
  getCachedCompositionRoot,
  resetCompositionRootForTests,
} from "./build-composition-root.js";

export { BUILT_IN_PRIORITIES, type BuiltInPriority } from "./priorities.js";

export { createBillingConfigurator } from "./configurators/billing-configurator.js";
export { createCommandBusConfigurator } from "./configurators/command-bus-configurator.js";
export { createCryptoConfigurator } from "./configurators/crypto-configurator.js";
export { createRbacConfigurator } from "./configurators/rbac-configurator.js";
export { createShippingConfigurator } from "./configurators/shipping-configurator.js";

export type {
  BillingConfiguration,
  BuildCompositionRootInput,
  CommandBusConfiguration,
  CompositionEnv,
  CompositionRoot,
  Configurator,
  CryptoConfiguration,
  RbacConfiguration,
  ShippingConfiguration,
} from "./types.js";

// Transitional convenience re-exports. Prefer the create*Configurator
// factories above for new code so the priority contract stays in
// one place.
export { configureBilling } from "@pharmax/billing";
export { configureCommandBus } from "@pharmax/command-bus";
export { configureCrypto } from "@pharmax/crypto";
export { configureRbac } from "@pharmax/rbac";
export { configureShipping } from "@pharmax/shipping";
