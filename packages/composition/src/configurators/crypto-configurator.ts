// Crypto Configurator.
//
// Thin Configurator wrapper around `@pharmax/crypto`'s
// `configureCrypto`. Exists so app code only ever imports
// configurator factories from `@pharmax/composition`, never the raw
// `configure*` functions — which keeps the ordering contract
// (priority numbers) co-located with the wiring.

import { configureCrypto, type CryptoConfiguration } from "@pharmax/crypto";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { Configurator } from "../types.js";

export function createCryptoConfigurator(config: CryptoConfiguration): Configurator {
  return Object.freeze({
    name: "@pharmax/crypto",
    priority: BUILT_IN_PRIORITIES.CRYPTO,
    apply(): void {
      configureCrypto(config);
    },
  });
}
