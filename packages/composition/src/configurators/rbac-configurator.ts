// RBAC Configurator.
//
// Wires `@pharmax/rbac`'s permission loader. Runs after crypto so
// the loader (which reads from Postgres) doesn't accidentally
// touch a PHI column before crypto is ready — today no PHI lives
// in the rbac path, but the ordering guard is cheap insurance for
// future loader implementations.

import { configureRbac, type RbacConfiguration } from "@pharmax/rbac";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { Configurator } from "../types.js";

export function createRbacConfigurator(config: RbacConfiguration): Configurator {
  return Object.freeze({
    name: "@pharmax/rbac",
    priority: BUILT_IN_PRIORITIES.RBAC,
    apply(): void {
      configureRbac(config);
    },
  });
}
