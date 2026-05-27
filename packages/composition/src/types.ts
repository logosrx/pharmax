// Public types for @pharmax/composition.
//
// The composition root is the typed, ordering-aware home for the
// "configure once, use everywhere" subsystems that every Pharmax
// entry point (apps/web, apps/worker, scripts) depends on.
//
// Why this lives here instead of inside each apps/* bootstrap:
//
//   1. The order of `configure*` calls is contractual — crypto MUST
//      be ready before any code path that touches PHI, the command
//      bus MUST be wired before any route can dispatch, etc. With
//      the wiring duplicated across apps/web/bootstrap.ts and
//      apps/worker/main.ts, the ordering invariants were implicit
//      and only enforced by code review.
//
//   2. Splitting apps/web into separate services (public-API,
//      operator-console, webhook-receiver) currently means
//      copy-pasting the entire sequence into each new entry point.
//      Centralizing the wiring means a new service is `await
//      buildCompositionRoot({...})` + its own routes, nothing else.
//
//   3. The typed `CompositionRoot` return value lets routes/drains
//      accept the wired adapters via parameter rather than reaching
//      for module-level singletons via `getRbacConfiguration()` /
//      `getCommandBusConfiguration()` etc. Both styles still work —
//      this just gives callers the option of explicit dependency
//      passing where it improves testability.

import type { BillingConfiguration } from "@pharmax/billing";
import type { CommandBusConfiguration } from "@pharmax/command-bus";
import type { CryptoConfiguration, KmsAdapter } from "@pharmax/crypto";
import type { PrismaClient, ShippingProvider } from "@pharmax/database";
import type { clock as clockTypes, logger as loggerTypes } from "@pharmax/platform-core";
import type { EffectivePermissionLoader, RbacConfiguration } from "@pharmax/rbac";
import type { ShippingAdapterFactory, ShippingConfiguration } from "@pharmax/shipping";

import type { StripeRefundPort } from "@pharmax/billing";

/**
 * The minimum env shape the composition root needs to enforce its
 * own invariants (production-vs-LocalKMS guard, seed-length sanity).
 *
 * Apps are free to pass a wider env object — only these keys are
 * read. The caller's app-specific env schema (apps/web/env.ts,
 * apps/worker/env.ts) already validates the rest.
 */
export interface CompositionEnv {
  readonly NODE_ENV: "development" | "test" | "production";

  /**
   * Dev/test KMS seed. The composition root checks length+presence
   * here in addition to whatever the caller's env schema validated,
   * so a misconfiguration produces ONE clear error message at boot
   * regardless of which entry point booted the process.
   *
   * apps/web and apps/worker MUST share this seed. There is no
   * cross-process detection at boot (the processes don't talk to
   * each other before traffic), but each app's env schema enforces
   * the same minimum length and the composition root re-asserts it
   * so a missing/short value fails LOUDLY at boot rather than
   * silently producing un-decryptable rows.
   */
  readonly PHARMAX_LOCAL_KMS_SEED: string;
}

/**
 * One wiring step. Each built-in `configure*` (crypto, rbac,
 * command-bus, shipping, billing) ships as a `Configurator`. New
 * packages can register themselves declaratively by exporting their
 * own `Configurator` and threading it through
 * `BuildCompositionRootInput.extraConfigurators`.
 *
 * The `priority` numbers are documented contracts — see
 * `BUILT_IN_PRIORITIES` in `./priorities.ts`. Lower numbers run
 * first. New packages should pick a priority that reflects their
 * actual ordering needs against the built-ins, not just append to
 * the end.
 */
export interface Configurator {
  /** Stable identifier used for logging and duplicate detection. */
  readonly name: string;

  /**
   * Run order. Lower = earlier. The composition root sorts
   * configurators by this number and runs them sequentially.
   *
   * Built-in priorities are exported from `./priorities.ts`. A new
   * package's configurator should pick a value that places it
   * correctly relative to those — e.g. anything that needs PHI
   * decryption at boot must come after `BUILT_IN_PRIORITIES.CRYPTO`.
   */
  readonly priority: number;

  /**
   * Apply the wiring. May be sync or async. The composition root
   * awaits each in order; a thrown error aborts the whole boot
   * (which is the right behavior — partial wiring is worse than no
   * wiring).
   */
  apply(): void | Promise<void>;
}

/**
 * Inputs to `buildCompositionRoot`. The caller (apps/web,
 * apps/worker, scripts/) builds the adapters and passes them in —
 * the composition root does NOT construct adapters itself, because
 * adapter selection (LocalKmsAdapter vs AwsKmsAdapter, Stripe vs
 * null, etc.) is the entry point's responsibility.
 */
export interface BuildCompositionRootInput {
  readonly env: CompositionEnv;
  readonly logger: loggerTypes.Logger;
  readonly clock: clockTypes.Clock;

  /** Prisma singleton from `@pharmax/database`. */
  readonly prisma: PrismaClient;

  /**
   * KMS adapter chosen by the caller. `LocalKmsAdapter` in dev/test;
   * the composition root refuses to boot in production with the
   * local adapter (see `validateProductionGuard`).
   */
  readonly kms: KmsAdapter;

  /**
   * RBAC loader implementation. Production uses
   * `PrismaPermissionLoader(prisma)`; tests use
   * `InMemoryPermissionLoader`.
   */
  readonly rbacLoader: EffectivePermissionLoader;

  /**
   * Per-provider shipping factories. The caller picks which
   * providers this entry point should support. apps/web and
   * apps/worker both register all three (EASYPOST, FEDEX, UPS);
   * a future webhook-only service might register only EASYPOST.
   */
  readonly shippingFactories: Partial<Record<ShippingProvider, ShippingAdapterFactory>>;

  /**
   * Stripe refund port. `null` when STRIPE_SECRET_KEY is unset; the
   * `IssueRefund` command surfaces `BILLING_REFUND_NOT_CONFIGURED`
   * in that case rather than crashing on SDK construction.
   */
  readonly stripeRefundPort: StripeRefundPort | null;

  /**
   * Extra configurators for forthcoming packages (notifications,
   * documents, etc.). The composition root sorts the full list by
   * `priority` and applies them sequentially.
   *
   * Use this — rather than calling `configureX` directly from app
   * code — so the ordering contract stays in one place.
   */
  readonly extraConfigurators?: ReadonlyArray<Configurator>;
}

/**
 * The wired result of a successful `buildCompositionRoot`. Routes,
 * drains, and tests may take a `CompositionRoot` parameter to avoid
 * reaching for module-level singletons.
 *
 * The fields here MUST match what was passed in — the composition
 * root does not construct anything new; it only orchestrates the
 * `configure*` side effects in order. Returning the inputs as a
 * single frozen object is the cheapest way to give callers an
 * explicit dependency handle.
 */
export interface CompositionRoot {
  readonly env: CompositionEnv;
  readonly logger: loggerTypes.Logger;
  readonly clock: clockTypes.Clock;
  readonly prisma: PrismaClient;
  readonly kms: KmsAdapter;
  readonly rbacLoader: EffectivePermissionLoader;
  readonly shippingFactories: Readonly<Partial<Record<ShippingProvider, ShippingAdapterFactory>>>;
  readonly stripeRefundPort: StripeRefundPort | null;
  /**
   * The configurator manifest that ran, in execution order. Useful
   * for boot logs and integration tests that want to assert the
   * full sequence.
   */
  readonly appliedConfigurators: ReadonlyArray<{
    readonly name: string;
    readonly priority: number;
  }>;
}

// Re-export the underlying configuration types so callers that DO
// want to construct configurators manually (advanced use, tests)
// have a one-stop import surface.
export type {
  BillingConfiguration,
  CommandBusConfiguration,
  CryptoConfiguration,
  RbacConfiguration,
  ShippingConfiguration,
};
