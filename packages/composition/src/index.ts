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

// Shared KMS adapter construction. The single source of truth for
// the "which KMS adapter, built how" decision tree that apps/web and
// apps/worker both boot with — extracted so the two processes cannot
// drift into deriving different data-key identities.
export {
  buildKmsAdapterFromEnv,
  parsePreviousDataKeyKeyIds,
  type BuildKmsAdapterInput,
  type BuiltKmsAdapter,
  type KmsAdapterEnv,
} from "./kms/build-kms-adapter.js";

export {
  createCacheFromEnv,
  createRedisCache,
  createIoredisRedisClient,
  type CreateCacheFromEnvInput,
  type CreateRedisCacheOptions,
  type IoredisLike,
  type RedisCacheHandle,
} from "./cache/ioredis-cache-client.js";

// Re-export the cache port + read-through helpers so consumers (apps/web,
// apps/worker) import the whole cache surface from the composition layer —
// the same one-stop-import principle the configurator factories follow.
export {
  cached,
  cacheKey,
  NoopCache,
  type Cache,
  type CacheSetOptions,
  type CachedOptions,
} from "@pharmax/cache";

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
