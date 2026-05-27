// buildCompositionRoot contract tests.
//
// Three groups of assertions:
//
//   1. Production / env guards trigger BEFORE any `configure*` runs.
//      A misconfigured env must not leave the bus in a half-wired
//      state.
//
//   2. The built-in configurators run in the documented priority
//      order: CRYPTO → RBAC → COMMAND_BUS → SHIPPING → BILLING.
//      Tests assert this by reading the `appliedConfigurators`
//      manifest on the returned root, AND by inspecting the
//      side-effect order via the underlying `getXConfiguration()`
//      readers.
//
//   3. Re-invocation is idempotent (returns the same cached root
//      without re-running any `configure*`). Process-wide singletons
//      that re-wire mid-traffic are a split-brain hazard.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getBillingConfiguration, resetBillingConfigurationForTests } from "@pharmax/billing";
import {
  getCommandBusConfiguration,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  LocalKmsAdapter,
  getCryptoConfiguration,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
import { clock as clockNs, logger as loggerNs } from "@pharmax/platform-core";
import {
  InMemoryPermissionLoader,
  getRbacConfiguration,
  resetRbacConfigurationForTests,
} from "@pharmax/rbac";
import { getShippingConfiguration, resetShippingConfigurationForTests } from "@pharmax/shipping";
import type { PrismaClient } from "@pharmax/database";

import {
  buildCompositionRoot,
  getCachedCompositionRoot,
  resetCompositionRootForTests,
} from "./build-composition-root.js";
import { BUILT_IN_PRIORITIES } from "./priorities.js";
import type { BuildCompositionRootInput, CompositionEnv, Configurator } from "./types.js";

/**
 * Minimal Prisma stub. The composition root forwards this to
 * `configureCommandBus` without invoking it, so an empty object
 * cast suffices for these wiring-shape tests. (The bus's own
 * tests use a real fake.)
 */
const fakePrisma = {} as unknown as PrismaClient;

const baseEnv: CompositionEnv = Object.freeze({
  NODE_ENV: "test",
  PHARMAX_LOCAL_KMS_SEED: "x".repeat(64),
});

function baseInput(overrides: Partial<BuildCompositionRootInput> = {}): BuildCompositionRootInput {
  return {
    env: baseEnv,
    logger: loggerNs.noopLogger,
    clock: clockNs.createFrozenClock(new Date("2026-05-21T00:00:00.000Z")),
    prisma: fakePrisma,
    kms: new LocalKmsAdapter({ seed: "x".repeat(64) }),
    rbacLoader: new InMemoryPermissionLoader([]),
    shippingFactories: {},
    stripeRefundPort: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetAllDownstream();
});

afterEach(() => {
  resetAllDownstream();
});

function resetAllDownstream(): void {
  resetCompositionRootForTests();
  resetCryptoConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCommandBusConfigurationForTests();
  resetShippingConfigurationForTests();
  resetBillingConfigurationForTests();
}

// ---------------------------------------------------------------------
// Env / production guards
// ---------------------------------------------------------------------

describe("buildCompositionRoot env guards", () => {
  it("refuses to boot when PHARMAX_LOCAL_KMS_SEED is shorter than 32 chars", async () => {
    const input = baseInput({
      env: { NODE_ENV: "test", PHARMAX_LOCAL_KMS_SEED: "tooshort" },
    });
    await expect(buildCompositionRoot(input)).rejects.toThrow(/PHARMAX_LOCAL_KMS_SEED/);
  });

  it("refuses to boot when PHARMAX_LOCAL_KMS_SEED is missing entirely", async () => {
    const input = baseInput({
      env: { NODE_ENV: "test", PHARMAX_LOCAL_KMS_SEED: undefined as unknown as string },
    });
    await expect(buildCompositionRoot(input)).rejects.toThrow(/PHARMAX_LOCAL_KMS_SEED/);
  });

  it("refuses to boot in production when kms is the LocalKmsAdapter", async () => {
    const input = baseInput({
      env: { NODE_ENV: "production", PHARMAX_LOCAL_KMS_SEED: "x".repeat(64) },
    });
    await expect(buildCompositionRoot(input)).rejects.toThrow(/LocalKmsAdapter/);
  });

  it("does NOT leave downstream packages half-configured when an env guard fires", async () => {
    const input = baseInput({
      env: { NODE_ENV: "production", PHARMAX_LOCAL_KMS_SEED: "x".repeat(64) },
    });
    await expect(buildCompositionRoot(input)).rejects.toThrow();
    // Nothing should have been wired — the guard runs BEFORE the
    // first configurator.apply().
    expect(() => getCryptoConfiguration()).toThrow();
    expect(() => getRbacConfiguration()).toThrow();
    expect(() => getCommandBusConfiguration()).toThrow();
    expect(() => getShippingConfiguration()).toThrow();
    expect(() => getBillingConfiguration()).toThrow();
  });
});

// ---------------------------------------------------------------------
// Configurator ordering invariants
// ---------------------------------------------------------------------

describe("buildCompositionRoot configurator ordering", () => {
  it("runs built-in configurators in the documented priority order", async () => {
    const root = await buildCompositionRoot(baseInput());
    expect(root.appliedConfigurators.map((c) => c.name)).toEqual([
      "@pharmax/crypto",
      "@pharmax/rbac",
      "@pharmax/command-bus",
      "@pharmax/shipping",
      "@pharmax/billing",
    ]);
    // And the priorities monotonically increase.
    const priorities = root.appliedConfigurators.map((c) => c.priority);
    for (let i = 1; i < priorities.length; i += 1) {
      expect(priorities[i]!).toBeGreaterThan(priorities[i - 1]!);
    }
  });

  it("wires each downstream package's getXConfiguration() reader", async () => {
    await buildCompositionRoot(baseInput());
    expect(getCryptoConfiguration().kms).toBeInstanceOf(LocalKmsAdapter);
    expect(getRbacConfiguration().loader).toBeInstanceOf(InMemoryPermissionLoader);
    expect(getCommandBusConfiguration().prisma).toBe(fakePrisma);
    expect(getShippingConfiguration().factories).toEqual({});
    expect(getBillingConfiguration().stripeRefundPort).toBeNull();
  });

  it("interleaves extra configurators by priority", async () => {
    // An "early" extra (priority 5) must run BEFORE crypto (10).
    // A "late" extra (priority 100) must run AFTER billing (50).
    // A "middle" extra (priority 25) must run between rbac (20)
    // and command-bus (30).
    const order: string[] = [];
    const trace = (name: string, priority: number): Configurator =>
      Object.freeze({
        name,
        priority,
        apply: () => {
          order.push(name);
        },
      });

    // We don't need to spy on the built-in `configure*` functions
    // — the appliedConfigurators manifest below captures the full
    // runtime order including built-ins. The manual extras
    // double-record into `order` so we can independently assert
    // the extras themselves ran (and ran in priority order, not
    // input order).

    const root = await buildCompositionRoot(
      baseInput({
        extraConfigurators: [trace("early", 5), trace("middle", 25), trace("late", 100)],
      })
    );

    expect(root.appliedConfigurators.map((c) => c.name)).toEqual([
      "early",
      "@pharmax/crypto",
      "@pharmax/rbac",
      "middle",
      "@pharmax/command-bus",
      "@pharmax/shipping",
      "@pharmax/billing",
      "late",
    ]);
    // The three extras above also ran, recorded in `order`.
    expect(order).toEqual(["early", "middle", "late"]);
  });

  it("awaits async configurators in order (does not start them in parallel)", async () => {
    const order: string[] = [];
    const makeAsync = (name: string, priority: number, delayMs: number): Configurator =>
      Object.freeze({
        name,
        priority,
        apply: async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          order.push(name);
        },
      });

    // "fast" has the LATER priority (200) but the SHORTER delay.
    // If the root ran configurators in parallel "fast" would land
    // before "slow"; sequential execution forces the opposite.
    await buildCompositionRoot(
      baseInput({
        extraConfigurators: [makeAsync("slow", 100, 10), makeAsync("fast", 200, 0)],
      })
    );
    expect(order).toEqual(["slow", "fast"]);
  });

  it("refuses duplicate configurator names across built-ins and extras", async () => {
    const dup: Configurator = Object.freeze({
      name: "@pharmax/crypto", // collides with the built-in name
      priority: 999,
      apply: () => undefined,
    });
    await expect(buildCompositionRoot(baseInput({ extraConfigurators: [dup] }))).rejects.toThrow(
      /Duplicate Configurator name/
    );
  });

  it("uses the documented built-in priority constants", () => {
    // Lock the numeric values via the public constant so a future
    // edit to priorities.ts is forced to update tests too.
    expect(BUILT_IN_PRIORITIES.CRYPTO).toBe(10);
    expect(BUILT_IN_PRIORITIES.RBAC).toBe(20);
    expect(BUILT_IN_PRIORITIES.COMMAND_BUS).toBe(30);
    expect(BUILT_IN_PRIORITIES.SHIPPING).toBe(40);
    expect(BUILT_IN_PRIORITIES.BILLING).toBe(50);
  });
});

// ---------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------

describe("buildCompositionRoot idempotency", () => {
  it("returns the same frozen root on subsequent calls", async () => {
    const first = await buildCompositionRoot(baseInput());
    const second = await buildCompositionRoot(baseInput());
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("does NOT re-run any configurator on the second call", async () => {
    let cryptoCalls = 0;
    const tracking: Configurator = Object.freeze({
      name: "tracking",
      priority: 1,
      apply: () => {
        cryptoCalls += 1;
      },
    });
    await buildCompositionRoot(baseInput({ extraConfigurators: [tracking] }));
    await buildCompositionRoot(baseInput({ extraConfigurators: [tracking] }));
    expect(cryptoCalls).toBe(1);
  });

  it("getCachedCompositionRoot exposes the cached root for tests", async () => {
    expect(getCachedCompositionRoot()).toBeNull();
    const root = await buildCompositionRoot(baseInput());
    expect(getCachedCompositionRoot()).toBe(root);
  });

  it("resetCompositionRootForTests drops the cache so the next call re-wires", async () => {
    const first = await buildCompositionRoot(baseInput());
    resetCompositionRootForTests();
    expect(getCachedCompositionRoot()).toBeNull();
    const second = await buildCompositionRoot(baseInput());
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------
// Transitional re-exports — make sure the index.ts surface compiles.
// ---------------------------------------------------------------------

describe("@pharmax/composition transitional re-exports", () => {
  it("re-exports the raw configure* functions", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.configureCrypto).toBe("function");
    expect(typeof mod.configureRbac).toBe("function");
    expect(typeof mod.configureCommandBus).toBe("function");
    expect(typeof mod.configureShipping).toBe("function");
    expect(typeof mod.configureBilling).toBe("function");
  });

  it("re-exports the create*Configurator factories", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.createCryptoConfigurator).toBe("function");
    expect(typeof mod.createRbacConfigurator).toBe("function");
    expect(typeof mod.createCommandBusConfigurator).toBe("function");
    expect(typeof mod.createShippingConfigurator).toBe("function");
    expect(typeof mod.createBillingConfigurator).toBe("function");
  });
});
