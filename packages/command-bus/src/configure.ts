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
import type {
  OrderWorkflowPolicy,
  OverlaySource,
  WorkflowPolicyOverlayCache,
} from "@pharmax/workflow";

import { commandBusNotConfiguredError } from "./errors.js";

/**
 * Tier-2 overlay resolution wiring (ADR-0019).
 *
 * The bus uses this slot to load the per-tenant
 * `MergedWorkflowPolicy` snapshot in `define-command.ts`'s
 * `resolvePolicy` step (right after the base policy row is loaded
 * and admissibility-checked). The merged snapshot is exposed to
 * handlers via `deps.policy.merged`.
 *
 * Three reasons this is OPTIONAL on the configuration:
 *
 *   - Phase-2 / Phase-3 tests configure a minimal bus without the
 *     overlay surface; the merged snapshot is absent and handlers
 *     fall back to reading the static base policy
 *     (`ORDER_STANDARD_V1`). That preserves the existing 200+ command
 *     handler tests without modification.
 *   - Bootstrap commands (`seed.ts`, migrations) run with no tenant
 *     context and SHOULD NOT touch the overlay table.
 *   - Apps that have not opted into Tier-2 (e.g. early staging
 *     environments) can run on the bus without paying the overlay
 *     read cost.
 *
 * Once configured, every command whose `loadPolicy` step fires will
 * have `policy.merged` populated. Handlers gain overlay behavior the
 * day they migrate from `ORDER_STANDARD_V1` to `deps.policy.merged`.
 *
 * PHI invariant: overlay rows are configuration, never patient data.
 * The resolver / source / cache see only org / clinic / policy ids.
 */
export interface OverlayResolutionConfig {
  /** Read port — typically a Prisma-backed implementation in production. */
  readonly source: OverlaySource;
  /**
   * Process-local overlay cache. Bus reuses the same instance for the
   * lifetime of the process; activation commands invalidate it after
   * commit via `invalidatePolicyCache` so sibling workers pick up the
   * new shape within the TTL.
   */
  readonly cache: WorkflowPolicyOverlayCache;
  /**
   * Look-up the immutable base `OrderWorkflowPolicy` shape for a
   * given `(code, version)`. The bus needs the shape — not just the
   * row id — to compose with overlays. Returning `undefined` for an
   * unknown code disables overlay resolution for that command (the
   * bus falls back to the row-only `LoadedPolicy`), so a newly-
   * introduced policy version is opt-in by registration rather than
   * a runtime error.
   */
  readonly basePolicyFor: (code: string, version: number) => OrderWorkflowPolicy | undefined;
}

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

  /**
   * Optional Tier-2 overlay resolution; see `OverlayResolutionConfig`.
   */
  readonly overlayResolution?: OverlayResolutionConfig;
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
