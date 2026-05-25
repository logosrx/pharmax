// Poll-loop tests use Vitest's fake timers to drive the schedule
// deterministically. They lock in:
//   - First tick runs immediately on start() (no initial delay).
//   - Subsequent ticks run on the configured interval.
//   - A thrown tick triggers errorBackoffMs before the next tick.
//   - stop() awaits the in-flight tick before resolving.
//   - stop() cancels any scheduled-but-not-started tick.
//   - start() after stop() throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger as loggerNs } from "@pharmax/platform-core";

import { createPollLoop } from "./poll-loop.js";

const noopLogger = loggerNs.noopLogger;

describe("createPollLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first tick immediately and reschedules at the interval", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const loop = createPollLoop({
      name: "test-immediate",
      intervalMs: 100,
      tick,
      logger: noopLogger,
    });

    loop.start();
    // Drain microtasks so the immediate tick resolves.
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(3);

    await loop.stop();
  });

  it("backs off on tick errors and recovers afterward", async () => {
    const tick = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);

    const loop = createPollLoop({
      name: "test-backoff",
      intervalMs: 100,
      errorBackoffMs: 5_000,
      tick,
      logger: noopLogger,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    // 100ms is short of the 5s backoff — no second tick yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(1);

    // After the full backoff window, the next tick fires.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(tick).toHaveBeenCalledTimes(2);

    // Steady state: subsequent ticks resume the normal interval.
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(3);

    await loop.stop();
  });

  it("stop() awaits an in-flight tick before resolving", async () => {
    let resolveTick: (() => void) | undefined;
    const tick = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        })
    );

    const loop = createPollLoop({
      name: "test-stop-awaits",
      intervalMs: 100,
      tick,
      logger: noopLogger,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = loop.stop().then(() => {
      stopped = true;
    });

    // Allow microtasks to run; stop must NOT resolve yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    // Complete the in-flight tick.
    resolveTick?.();
    await stopPromise;
    expect(stopped).toBe(true);

    // No further ticks scheduled after stop.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels a scheduled-but-not-yet-started tick", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const loop = createPollLoop({
      name: "test-stop-cancels",
      intervalMs: 1_000,
      tick,
      logger: noopLogger,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    // Stop while waiting for the next interval; the next tick must
    // never fire.
    await loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("start() after stop() throws", async () => {
    const loop = createPollLoop({
      name: "test-no-restart",
      intervalMs: 100,
      tick: vi.fn().mockResolvedValue(undefined),
      logger: noopLogger,
    });

    loop.start();
    await loop.stop();
    expect(() => loop.start()).toThrowError(/cannot be restarted/);
  });
});
