// Process-level command-bus configuration.
//
// One process, one bus. The bus owns the Prisma client used for
// transactions, the clock for deterministic time stamps, the ULID
// factory for record ids, and the logger.
//
// Why a singleton instead of dependency injection at the dispatch
// site:
//   - Domain code calls `dispatchCommand(CreateOrder, input, opts)`.
//     Threading prisma/clock/logger through every call site adds
//     noise to the most-reviewed code in the codebase. The bus is
//     infrastructure; commands are domain.
//   - Tests configure once per `describe` block via `configureCommandBus`
//     with a fake Prisma client, `FrozenClock`, and `noopLogger`. The
//     ergonomics match `vi.mock`.
//
// Re-configuration is allowed and useful in tests. It is NOT
// thread-safe for production; production configuration happens at
// boot, before any traffic.

import type { PrismaClient } from "@pharmax/database";
import type { clock as clockTypes, logger as loggerTypes } from "@pharmax/platform-core";

import { commandBusNotConfiguredError } from "./errors.js";

export interface CommandBusConfiguration {
  /**
   * The Prisma client used to open transactions and write
   * command_log / audit_log / event_outbox / idempotency_key rows.
   * In tests this is a minimal fake that implements only the methods
   * the bus actually calls.
   */
  readonly prisma: PrismaClient;

  /**
   * Source of timestamps. The bus stamps command_log, audit_log,
   * event_outbox, and idempotency_key rows from this clock so tests
   * can freeze time and snapshots are reproducible.
   */
  readonly clock: clockTypes.Clock;

  /**
   * Logger used for the bus's own structured events ("command
   * accepted", "command failed", "idempotency hit"). Handler-internal
   * logs come from the handler's own logger; this one is for the bus
   * surface.
   */
  readonly logger: loggerTypes.Logger;
}

let configured: CommandBusConfiguration | null = null;

/**
 * Wire the process-wide command bus. Call once at boot (apps/web,
 * apps/worker, migrations that issue commands).
 */
export function configureCommandBus(config: CommandBusConfiguration): void {
  configured = Object.freeze({ ...config });
}

/**
 * Returns the configured command bus configuration. Throws
 * `InternalError(COMMAND_BUS_NOT_CONFIGURED)` if `configureCommandBus`
 * was never called.
 */
export function getCommandBusConfiguration(): CommandBusConfiguration {
  if (configured === null) {
    throw commandBusNotConfiguredError();
  }
  return configured;
}

/**
 * Test-only: reset the configuration. Production code MUST NOT
 * call this.
 */
export function resetCommandBusConfigurationForTests(): void {
  configured = null;
}
