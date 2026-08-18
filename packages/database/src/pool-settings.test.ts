import { describe, expect, it } from "vitest";

import {
  assertTransactionWaitWithinPoolTimeout,
  DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  resolvePoolSettings,
} from "./client.js";

describe("resolvePoolSettings", () => {
  // Pinned deliberately. These were the effective values before the pool
  // became configurable — `pg`'s own default of 10 and the acquisition
  // timeout carried over from the v6 Rust engine. Reproducing them means
  // making the pool configurable changes nothing until someone sets a
  // variable, so this commit cannot move production behaviour by
  // accident. Changing either number is a real change to every
  // environment and should have to edit a test that says so.
  it("defaults to the historical values", () => {
    expect(DEFAULT_POOL_MAX).toBe(10);
    expect(DEFAULT_POOL_ACQUIRE_TIMEOUT_MS).toBe(5_000);
    expect(resolvePoolSettings({})).toEqual({ max: 10, connectionTimeoutMillis: 5_000 });
  });

  it("reads both variables", () => {
    expect(
      resolvePoolSettings({
        DATABASE_POOL_MAX: "40",
        DATABASE_POOL_ACQUIRE_TIMEOUT_MS: "15000",
      })
    ).toEqual({ max: 40, connectionTimeoutMillis: 15_000 });
  });

  it("overrides each field independently", () => {
    expect(resolvePoolSettings({ DATABASE_POOL_MAX: "3" })).toEqual({
      max: 3,
      connectionTimeoutMillis: DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
    });
  });

  // A malformed pool size is a deployment typo. Falling back beats
  // refusing to boot, and beats silently running a pool of NaN.
  it.each([
    ["empty", ""],
    ["whitespace", "  "],
    ["not a number", "lots"],
    ["zero", "0"],
    ["negative", "-4"],
    ["fractional", "7.5"],
  ])("ignores a %s pool size", (_label, raw) => {
    expect(resolvePoolSettings({ DATABASE_POOL_MAX: raw }).max).toBe(DEFAULT_POOL_MAX);
  });
});

describe("assertTransactionWaitWithinPoolTimeout", () => {
  // The 2026-08-17 incident in one assertion. The command bus raised its
  // `maxWait` to 30s and nothing changed, because `pg` gave up acquiring
  // a connection at its own 5s and Prisma surfaced that as "unable to
  // start a transaction". Two timeouts govern one wait; the smaller
  // always wins, so a larger `maxWait` is not merely ineffective — it
  // makes the configuration describe a wait that cannot happen.
  it("rejects a maxWait above the pool acquisition timeout", () => {
    expect(assertTransactionWaitWithinPoolTimeout(30_000, 5_000)).toEqual({
      ok: false,
      maxWaitMs: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it("accepts a maxWait below the pool timeout", () => {
    expect(assertTransactionWaitWithinPoolTimeout(2_000, 5_000)).toEqual({ ok: true });
  });

  it("accepts equality, which is coherent rather than merely lucky", () => {
    expect(assertTransactionWaitWithinPoolTimeout(5_000, 5_000)).toEqual({ ok: true });
  });

  it("holds for the values the E2E harness sets", () => {
    // e2e/env.ts sets maxWait 20s against a 20s pool timeout. If someone
    // raises one without the other, this fails here rather than 15
    // minutes into a Playwright run.
    expect(assertTransactionWaitWithinPoolTimeout(20_000, 20_000)).toEqual({ ok: true });
  });
});
