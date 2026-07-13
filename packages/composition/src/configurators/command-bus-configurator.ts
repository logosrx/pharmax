// Command Bus Configurator.
//
// Wires Prisma + clock + logger into `@pharmax/command-bus`. MUST
// run after RBAC because the bus's dispatch step invokes
// `requirePermission`; calling dispatch before RBAC is configured
// throws `RBAC_NOT_CONFIGURED` from inside the bus.
//
// Request-hash key: when a KMS adapter is supplied, `apply()`
// derives the bus's idempotency request-hash HMAC key from it
// (stable per KMS key, shared by every process pointing at the same
// KMS). This keeps `idempotency_key.requestHash` non-reversible
// without introducing a new shared secret. The derivation is a
// single cached KMS call at boot. Also MUST run after CRYPTO in
// priority order (it does — see BUILT_IN_PRIORITIES), although the
// adapter is passed explicitly so there is no hidden singleton
// dependency.

import { configureCommandBus, type CommandBusConfiguration } from "@pharmax/command-bus";
import type { KmsAdapter } from "@pharmax/crypto";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { Configurator } from "../types.js";

export interface CommandBusConfiguratorInput extends CommandBusConfiguration {
  /**
   * KMS adapter used to derive the request-hash HMAC key at boot.
   * Optional so bare test wirings keep working; production entry
   * points (which all pass through `buildCompositionRoot`) always
   * provide it.
   */
  readonly kmsForRequestHashKey?: KmsAdapter;
}

export function createCommandBusConfigurator(config: CommandBusConfiguratorInput): Configurator {
  const { kmsForRequestHashKey, ...busConfig } = config;
  return Object.freeze({
    name: "@pharmax/command-bus",
    priority: BUILT_IN_PRIORITIES.COMMAND_BUS,
    async apply(): Promise<void> {
      if (kmsForRequestHashKey === undefined || busConfig.requestHashKey !== undefined) {
        configureCommandBus(busConfig);
        return;
      }
      // "platform" is a fixed pseudo-tenant: the request-hash key is
      // process-wide (the org id is already part of the hashed
      // payload's uniqueness scope via the idempotency table's
      // composite key), and a per-tenant key would force a KMS call
      // on first command per tenant for no added protection.
      const requestHashKey = await kmsForRequestHashKey.deriveSearchKey({
        tenantId: "platform",
        purpose: "command-bus.request-hash",
      });
      configureCommandBus({ ...busConfig, requestHashKey });
    },
  });
}
