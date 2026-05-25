import { describe, expect, it } from "vitest";

import { createFrozenClock } from "../clock/test-clocks.js";

import { createUlidFactory, generateUlid, ULID_LENGTH } from "./ulid.js";

describe("ULID", () => {
  describe("generateUlid", () => {
    it("returns a 26-character upper-case Crockford base32 string", () => {
      const id = generateUlid();
      expect(id).toHaveLength(ULID_LENGTH);
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });
  });

  describe("createUlidFactory", () => {
    it("issues monotonically-increasing ids when the clock does not advance", () => {
      // Within a single millisecond the underlying monotonic factory
      // must still produce ids that compare strictly greater.
      const clock = createFrozenClock(new Date("2026-05-13T12:00:00.000Z"));
      const factory = createUlidFactory({ clock });
      const ids = Array.from({ length: 5 }, () => factory.next());

      for (let i = 1; i < ids.length; i += 1) {
        const prev = ids[i - 1];
        const curr = ids[i];
        expect(prev).toBeDefined();
        expect(curr).toBeDefined();
        expect(curr! > prev!).toBe(true);
      }
    });

    it("issues ids that sort lexicographically by creation time across millisecond boundaries", () => {
      const clock = createFrozenClock(new Date("2026-05-13T12:00:00.000Z"));
      const factory = createUlidFactory({ clock });

      const a = factory.next();
      clock.advance(50);
      const b = factory.next();
      clock.advance(50);
      const c = factory.next();

      const sorted = [c, a, b].sort();
      expect(sorted).toEqual([a, b, c]);
    });

    it("uses the system clock when none is provided", () => {
      const factory = createUlidFactory();
      const id = factory.next();
      expect(id).toHaveLength(ULID_LENGTH);
    });

    it("isolates monotonic state per factory instance", () => {
      // The ulid library's underlying monotonicFactory keeps internal
      // counter state. Per-instance factories prevent test-to-test
      // leakage and allow independent timelines in tests.
      const clock = createFrozenClock(new Date("2026-05-13T12:00:00.000Z"));
      const a = createUlidFactory({ clock });
      const b = createUlidFactory({ clock });

      const fromA = a.next();
      const fromB = b.next();

      // Both factories use the same clock at the same instant, so
      // their first ids share the timestamp prefix but the random
      // suffix differs.
      expect(fromA.substring(0, 10)).toBe(fromB.substring(0, 10));
      expect(fromA).not.toBe(fromB);
    });
  });
});
