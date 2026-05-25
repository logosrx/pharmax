// ULID generator.
//
// We use ULIDs (NOT UUIDs) for ids that need to be issued BEFORE a
// database row is written, because:
//
//   - The command bus emits `command_log.id` before opening the
//     transaction. The actor needs that id returned even if the
//     transaction rolls back. UUIDs work, but ULIDs additionally
//     sort lexicographically by creation time, which makes audit
//     log spelunking far cheaper (no `ORDER BY created_at` needed
//     when you already have the id range).
//
//   - The `ulid` library guarantees monotonicity within the same
//     millisecond — repeated calls in a tight loop produce strictly
//     increasing values, so audit ordering does not lose precision
//     under bus throughput.
//
// IMPORTANT: ULIDs are NOT secrets. Do not use them as session tokens
// or anything where unpredictability matters. They embed a 48-bit
// millisecond timestamp; an observer with several samples can infer
// approximate creation time.
//
// Database identity columns (User.id, Order.id, etc.) remain UUIDs
// per the Prisma schema — those are written inside the DB transaction
// and don't need pre-issuance.

import { monotonicFactory, ulid as randomUlid } from "ulid";

import type { Clock } from "../clock/clock.js";
import { systemClock } from "../clock/system-clock.js";

export interface UlidFactory {
  /**
   * Generate a new ULID using the configured clock. Strictly
   * monotonic within the same millisecond.
   */
  next(): string;
}

export interface CreateUlidFactoryOptions {
  readonly clock?: Clock;
}

/**
 * Create a monotonic ULID generator bound to the given (or system) clock.
 *
 * Each factory instance maintains its own monotonic state, so tests
 * should construct a fresh factory per test to avoid order leakage
 * between cases. Production code constructs the factory once at app
 * boot and reuses it via DI.
 */
export function createUlidFactory(options: CreateUlidFactoryOptions = {}): UlidFactory {
  const clock = options.clock ?? systemClock;
  const factory = monotonicFactory();
  return {
    next(): string {
      return factory(clock.now().getTime());
    },
  };
}

/**
 * Convenience non-monotonic generator using the system clock. Suitable
 * for one-off ids in scripts and tests; do NOT use this in the
 * command bus or any hot path where ordering matters.
 */
export function generateUlid(): string {
  return randomUlid();
}

export const ULID_LENGTH = 26;
