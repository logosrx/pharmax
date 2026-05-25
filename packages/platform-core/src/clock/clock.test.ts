import { describe, expect, it } from "vitest";

import { createAdvancingClock, createFrozenClock, systemClock } from "./index.js";

describe("clock", () => {
  describe("systemClock", () => {
    it("returns a Date close to the current wall time", () => {
      const before = Date.now();
      const now = systemClock.now();
      const after = Date.now();
      expect(now).toBeInstanceOf(Date);
      expect(now.getTime()).toBeGreaterThanOrEqual(before);
      expect(now.getTime()).toBeLessThanOrEqual(after);
    });

    it("returns a fresh Date instance on each call (no shared mutable state)", () => {
      const a = systemClock.now();
      const b = systemClock.now();
      expect(a).not.toBe(b);
    });
  });

  describe("createFrozenClock", () => {
    const t0 = new Date("2026-05-13T12:00:00.000Z");

    it("returns the seed instant on every call until set()/advance()", () => {
      const clock = createFrozenClock(t0);
      expect(clock.now().getTime()).toBe(t0.getTime());
      expect(clock.now().getTime()).toBe(t0.getTime());
    });

    it("set() replaces the current instant", () => {
      const clock = createFrozenClock(t0);
      const t1 = new Date("2026-06-01T00:00:00.000Z");
      clock.set(t1);
      expect(clock.now().getTime()).toBe(t1.getTime());
    });

    it("advance(ms) moves the current instant forward", () => {
      const clock = createFrozenClock(t0);
      clock.advance(5_000);
      expect(clock.now().getTime()).toBe(t0.getTime() + 5_000);
    });

    it("returns Date copies so callers cannot mutate the internal state", () => {
      const clock = createFrozenClock(t0);
      const now = clock.now();
      now.setUTCFullYear(1999);
      expect(clock.now().getUTCFullYear()).toBe(2026);
    });
  });

  describe("createAdvancingClock", () => {
    const t0 = new Date("2026-05-13T12:00:00.000Z");

    it("advances by stepMs on each read so consecutive reads are strictly greater", () => {
      const clock = createAdvancingClock(t0, 10);
      const a = clock.now().getTime();
      const b = clock.now().getTime();
      const c = clock.now().getTime();
      expect(a).toBe(t0.getTime());
      expect(b).toBe(t0.getTime() + 10);
      expect(c).toBe(t0.getTime() + 20);
    });

    it("defaults to a 1ms step", () => {
      const clock = createAdvancingClock(t0);
      const a = clock.now().getTime();
      const b = clock.now().getTime();
      expect(b - a).toBe(1);
    });
  });
});
