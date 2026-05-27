// Command Bus Configurator.
//
// Wires Prisma + clock + logger into `@pharmax/command-bus`. MUST
// run after RBAC because the bus's dispatch step invokes
// `requirePermission`; calling dispatch before RBAC is configured
// throws `RBAC_NOT_CONFIGURED` from inside the bus.

import { configureCommandBus, type CommandBusConfiguration } from "@pharmax/command-bus";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { Configurator } from "../types.js";

export function createCommandBusConfigurator(config: CommandBusConfiguration): Configurator {
  return Object.freeze({
    name: "@pharmax/command-bus",
    priority: BUILT_IN_PRIORITIES.COMMAND_BUS,
    apply(): void {
      configureCommandBus(config);
    },
  });
}
