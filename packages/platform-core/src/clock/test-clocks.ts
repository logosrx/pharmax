// Test clocks. NOT for production use.
//
// `FrozenClock` returns the same instant on every call — use for any
// test that asserts a write happens with a known timestamp. Mutate
// the instant with `set(date)` to simulate the passage of time
// explicitly.
//
// `AdvancingClock` returns the seed instant and increments by
// `stepMs` on every read. Use for tests that need each `now()` to
// produce a strictly-greater value (e.g. SLA interval recorder, where
// `endedAt > startedAt` is an invariant). Default step of 1ms matches
// Postgres `timestamp(3)` granularity.

import type { Clock } from "./clock.js";

export interface MutableClock extends Clock {
  set(date: Date): void;
  advance(ms: number): void;
}

export function createFrozenClock(initial: Date): MutableClock {
  let current = initial;
  return {
    now(): Date {
      return new Date(current.getTime());
    },
    set(date: Date): void {
      current = date;
    },
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}

export function createAdvancingClock(initial: Date, stepMs = 1): MutableClock {
  let current = initial;
  return {
    now(): Date {
      const snapshot = new Date(current.getTime());
      current = new Date(current.getTime() + stepMs);
      return snapshot;
    },
    set(date: Date): void {
      current = date;
    },
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}
