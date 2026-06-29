// Process-wide multi-carrier shipping configuration.
//
// Each `ShippingProvider` value (EASYPOST, FEDEX, UPS) may have a
// **factory** registered that turns a per-org credential into a
// configured `ShippingAdapter` instance. The factory pattern lets
// us share one process-wide HTTP client (or one provider-specific
// SDK) while per-org adapters get the right credentials at call
// time — and lets tests inject a stub factory without touching
// real HTTP.
//
// Why factories instead of a single global adapter:
//   - Credentials are per-tenant (see `carrier_credential` table).
//     The same `EasyPostShippingAdapter` class with a different API
//     key is a different runtime instance.
//   - Adding a carrier becomes a one-line `configureShipping`
//     extension at boot — no domain-package changes.
//   - Tests can register a single deterministic factory per provider
//     and exercise the command path end-to-end without HTTP.
//
// Reading an unregistered provider throws
// `InternalError(SHIPPING_PROVIDER_NOT_REGISTERED)` — silence here
// would let a command silently fall back to the wrong adapter, which
// is the worst possible outcome for a label-purchase flow.

import type { ShippingProvider } from "@pharmax/database";
import { errors, runtime } from "@pharmax/platform-core";

import type { ShippingAdapter } from "./carriers/shipping-adapter.js";

/**
 * Per-org carrier credential resolved by `resolveShippingAdapter` and
 * passed to the registered factory. The factory uses these values to
 * build a configured adapter instance.
 *
 * `apiKey` and `webhookSecret` arrive as PLAINTEXT (already decrypted
 * from the `carrier_credential.{apiKeyEnc,webhookSecretEnc}` columns
 * by `resolveShippingAdapter`). The factory MUST NOT log them, MUST
 * NOT serialize them into audit metadata, and MUST not retain them
 * beyond the request lifetime.
 */
export interface CarrierCredentialContext {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly apiKey: string;
  readonly webhookSecret: string | null;
  readonly carrierAccountId: string | null;
  readonly baseUrl: string | null;
}

export type ShippingAdapterFactory = (ctx: CarrierCredentialContext) => ShippingAdapter;

export interface ShippingConfiguration {
  readonly factories: Partial<Record<ShippingProvider, ShippingAdapterFactory>>;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<ShippingConfiguration>("pharmax:shipping:config");

/**
 * Register one factory per provider you want to support. Call once
 * at boot (apps/web, apps/worker, scripts). Calling again replaces
 * the previous configuration — useful in tests via
 * `resetShippingConfigurationForTests`.
 */
export function configureShipping(config: ShippingConfiguration): void {
  box.value = Object.freeze({
    factories: Object.freeze({ ...config.factories }),
  });
}

export function getShippingConfiguration(): ShippingConfiguration {
  if (box.value === null) {
    throw new errors.InternalError({
      code: "SHIPPING_NOT_CONFIGURED",
      message:
        "@pharmax/shipping is not configured. Call configureShipping({ factories: { ... } }) at boot before invoking a shipping command.",
    });
  }
  return box.value;
}

/**
 * Look up the factory for a provider. Throws if unregistered — the
 * intent here is to fail loud rather than fall back silently to a
 * different carrier.
 */
export function getShippingAdapterFactory(provider: ShippingProvider): ShippingAdapterFactory {
  const factory = getShippingConfiguration().factories[provider];
  if (factory === undefined) {
    throw new errors.InternalError({
      code: "SHIPPING_PROVIDER_NOT_REGISTERED",
      message: `No ShippingAdapter factory is registered for provider ${provider}. Add it to configureShipping at boot.`,
      metadata: { provider },
    });
  }
  return factory;
}

export function resetShippingConfigurationForTests(): void {
  box.value = null;
}
