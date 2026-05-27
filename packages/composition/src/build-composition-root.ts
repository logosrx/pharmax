// buildCompositionRoot — the typed, ordering-aware entry-point
// wiring used by every Pharmax process (apps/web, apps/worker,
// scripts, future split services).
//
// What it does (in order):
//
//   1. Validate the slice of env it cares about. Today: the
//      production-vs-LocalKMS guard and a defensive re-check of
//      the dev/test KMS seed length. Each app's own env schema
//      already validated everything else; this is a SECOND assertion
//      so a misconfig produces ONE clear error message regardless
//      of which entry point booted the process.
//
//   2. Assemble the configurator list (built-ins + caller-provided
//      extras), sort by priority, run sequentially. The sort is
//      stable, so two configurators with the same priority run in
//      the order the caller supplied them — but built-in numbers
//      are unique by construction so this only matters for caller
//      extras.
//
//   3. Return a frozen `CompositionRoot` with the wired adapters
//      and the applied-configurator manifest. Routes/drains/tests
//      may take a `CompositionRoot` parameter to avoid reaching
//      for the module-level singletons (`getRbacConfiguration()`
//      etc.) — both styles still work.
//
// Idempotency: a process-wide module-level cache returns the same
// frozen root on subsequent calls (no-op reconfiguration). Next.js
// dev-mode HMR can re-import server modules many times; this guard
// matches the existing `let booted = false` pattern in
// apps/*/bootstrap.ts.

import type {
  CompositionEnv,
  BuildCompositionRootInput,
  CompositionRoot,
  Configurator,
} from "./types.js";
import { createBillingConfigurator } from "./configurators/billing-configurator.js";
import { createCommandBusConfigurator } from "./configurators/command-bus-configurator.js";
import { createCryptoConfigurator } from "./configurators/crypto-configurator.js";
import { createRbacConfigurator } from "./configurators/rbac-configurator.js";
import { createShippingConfigurator } from "./configurators/shipping-configurator.js";

let cachedRoot: CompositionRoot | null = null;

/**
 * Build (or return the cached) composition root. Safe to call
 * multiple times — subsequent calls return the same frozen root
 * without re-invoking any `configure*` function.
 *
 * THROWS at boot if:
 *
 *   - `env.NODE_ENV === "production"`: refuses to boot with the
 *     `LocalKmsAdapter` shape. Production must wire AwsKmsAdapter
 *     (or equivalent HSM-backed adapter) into `input.kms`. The
 *     guard is necessary because LocalKmsAdapter derives keys
 *     from a process-local seed; promoting that to prod would put
 *     PHI under a key with no HSM custody.
 *
 *   - `env.PHARMAX_LOCAL_KMS_SEED` is missing or shorter than 32
 *     chars. Each app's env schema already enforces this; the
 *     re-check here makes the requirement loud in one place. NOTE:
 *     the composition root CANNOT detect that apps/web and
 *     apps/worker were started with DIFFERENT seeds — the
 *     processes don't talk to each other before traffic. The two
 *     env schemas plus this guard make the requirement obvious;
 *     enforcement is operational (single source of truth for the
 *     seed in your secrets manager).
 *
 *   - Two configurators in the merged list share the same `name`.
 *     The name is the duplicate-detection key; matching priorities
 *     are allowed (and run in input order).
 */
export async function buildCompositionRoot(
  input: BuildCompositionRootInput
): Promise<CompositionRoot> {
  if (cachedRoot !== null) {
    return cachedRoot;
  }

  validateProductionGuard(input);
  validateKmsSeed(input.env);

  const configurators = mergeAndSortConfigurators(input);

  for (const configurator of configurators) {
    await configurator.apply();
  }

  cachedRoot = Object.freeze({
    env: input.env,
    logger: input.logger,
    clock: input.clock,
    prisma: input.prisma,
    kms: input.kms,
    rbacLoader: input.rbacLoader,
    shippingFactories: Object.freeze({ ...input.shippingFactories }),
    stripeRefundPort: input.stripeRefundPort,
    appliedConfigurators: Object.freeze(
      configurators.map((c) => Object.freeze({ name: c.name, priority: c.priority }))
    ),
  });

  return cachedRoot;
}

/**
 * Test-only: drop the cached root so the next call re-wires from
 * scratch. Production code MUST NOT call this — re-wiring an
 * already-wired bus mid-traffic is a recipe for split-brain
 * configuration. Mirrors the `resetXForTests` pattern from each
 * downstream package.
 */
export function resetCompositionRootForTests(): void {
  cachedRoot = null;
}

/**
 * Test-only: peek at the cached root without forcing
 * re-construction. Returns `null` if no root has been built yet.
 */
export function getCachedCompositionRoot(): CompositionRoot | null {
  return cachedRoot;
}

function validateProductionGuard(input: BuildCompositionRootInput): void {
  if (input.env.NODE_ENV !== "production") {
    return;
  }
  // We cannot reliably probe the adapter type at runtime (an
  // adapter wrapping LocalKmsAdapter would slip past an instanceof
  // check), so the production guard is the env-NODE_ENV branch
  // itself. Each app's bootstrap.ts also enforces this — the
  // composition root re-asserts because a future entry point may
  // forget to add the pre-check at the call site. Together: defense
  // in depth.
  //
  // Production callers MUST construct `input.kms` as an
  // AwsKmsAdapter (or equivalent HSM-backed adapter) and set
  // `NODE_ENV` accordingly. The boot fails loudly here if the
  // entry point left the LocalKmsAdapter branch in place.
  const kmsCtorName = input.kms.constructor.name;
  if (kmsCtorName === "LocalKmsAdapter") {
    throw new Error(
      "Refusing to build composition root in production with LocalKmsAdapter. " +
        "Wire an HSM-backed adapter (e.g. AwsKmsAdapter) into BuildCompositionRootInput.kms before promoting."
    );
  }
}

function validateKmsSeed(env: CompositionEnv): void {
  // Each app's env schema already enforces `z.string().min(32)`.
  // We re-check here so a misconfig produces ONE error message
  // regardless of entry point, AND so a future entry point that
  // forgets to add the schema rule still fails at composition.
  if (typeof env.PHARMAX_LOCAL_KMS_SEED !== "string" || env.PHARMAX_LOCAL_KMS_SEED.length < 32) {
    throw new Error(
      "Composition root requires PHARMAX_LOCAL_KMS_SEED to be at least 32 chars. " +
        "apps/web and apps/worker MUST share the same seed value or rows encrypted by " +
        "one process are undecryptable by the other."
    );
  }
}

function mergeAndSortConfigurators(input: BuildCompositionRootInput): ReadonlyArray<Configurator> {
  const builtIns: ReadonlyArray<Configurator> = [
    createCryptoConfigurator({ kms: input.kms }),
    createRbacConfigurator({ loader: input.rbacLoader }),
    createCommandBusConfigurator({
      prisma: input.prisma,
      clock: input.clock,
      logger: input.logger.child({ component: "command-bus" }),
    }),
    createShippingConfigurator({ factories: input.shippingFactories }),
    createBillingConfigurator({ stripeRefundPort: input.stripeRefundPort }),
  ];

  const merged: ReadonlyArray<Configurator> = [...builtIns, ...(input.extraConfigurators ?? [])];

  assertUniqueNames(merged);

  // Stable sort by priority. Array.prototype.sort is stable in V8
  // since Node 12, so ties between caller-supplied extras run in
  // the order the caller supplied them — useful when a caller adds
  // two configurators at the same priority and wants the visible
  // order preserved.
  return [...merged].sort((a, b) => a.priority - b.priority);
}

function assertUniqueNames(configurators: ReadonlyArray<Configurator>): void {
  const seen = new Set<string>();
  for (const c of configurators) {
    if (seen.has(c.name)) {
      throw new Error(
        `Duplicate Configurator name '${c.name}' supplied to buildCompositionRoot. ` +
          "Each configurator name must be unique across built-ins and extras."
      );
    }
    seen.add(c.name);
  }
}
