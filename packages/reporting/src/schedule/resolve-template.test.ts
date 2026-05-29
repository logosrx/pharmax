// Date-placeholder resolver tests.
//
// Pure function — no fake clients needed. Assertions:
//   - Every placeholder resolves to the expected offset against
//     a known `now`.
//   - Non-placeholder values pass through unchanged.
//   - The output is a fresh object (input not mutated).

import { describe, expect, it } from "vitest";

import {
  isRelativeDatePlaceholder,
  RELATIVE_DATE_PLACEHOLDERS,
  resolveRelativeDate,
  resolveTemplate,
} from "./resolve-template.js";

const NOW = new Date("2026-05-28T12:00:00.000Z");

describe("isRelativeDatePlaceholder", () => {
  it("returns true for every entry in RELATIVE_DATE_PLACEHOLDERS", () => {
    for (const p of RELATIVE_DATE_PLACEHOLDERS) {
      expect(isRelativeDatePlaceholder(p)).toBe(true);
    }
  });

  it("returns false for arbitrary strings", () => {
    expect(isRelativeDatePlaceholder("now-1d")).toBe(false);
    expect(isRelativeDatePlaceholder("yesterday")).toBe(false);
    expect(isRelativeDatePlaceholder("")).toBe(false);
  });
});

describe("resolveRelativeDate", () => {
  it("resolves `now` to the anchor", () => {
    expect(resolveRelativeDate("now", NOW).toISOString()).toBe(NOW.toISOString());
  });

  it.each([
    ["now-1h", 1 * 60 * 60 * 1000],
    ["now-6h", 6 * 60 * 60 * 1000],
    ["now-12h", 12 * 60 * 60 * 1000],
    ["now-24h", 24 * 60 * 60 * 1000],
    ["now-7d", 7 * 24 * 60 * 60 * 1000],
    ["now-14d", 14 * 24 * 60 * 60 * 1000],
    ["now-30d", 30 * 24 * 60 * 60 * 1000],
    ["now-90d", 90 * 24 * 60 * 60 * 1000],
  ] as const)("`%s` resolves to anchor minus %dms", (placeholder, offsetMs) => {
    const resolved = resolveRelativeDate(placeholder, NOW);
    expect(NOW.getTime() - resolved.getTime()).toBe(offsetMs);
  });
});

describe("resolveTemplate", () => {
  it("substitutes only string-valued placeholder keys", () => {
    const out = resolveTemplate({
      template: {
        from: "now-30d",
        to: "now",
        clinicId: "some-uuid",
        statuses: ["SHIPPED", "READY_TO_SHIP"],
      },
      now: NOW,
    });
    expect(out["from"]).toBeInstanceOf(Date);
    expect((out["from"] as Date).getTime()).toBe(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(out["to"]).toBeInstanceOf(Date);
    expect(out["clinicId"]).toBe("some-uuid");
    expect(out["statuses"]).toEqual(["SHIPPED", "READY_TO_SHIP"]);
  });

  it("does not mutate the input template", () => {
    const template = { from: "now-30d", to: "now" };
    const original = { ...template };
    resolveTemplate({ template, now: NOW });
    expect(template).toEqual(original);
  });

  it("passes through non-placeholder strings unchanged", () => {
    const out = resolveTemplate({
      template: { weird: "not-a-placeholder", num: 42 },
      now: NOW,
    });
    expect(out["weird"]).toBe("not-a-placeholder");
    expect(out["num"]).toBe(42);
  });
});
