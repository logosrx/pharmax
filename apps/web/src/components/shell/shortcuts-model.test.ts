import { describe, expect, it } from "vitest";

import {
  CHORD_WINDOW_MS,
  advanceChord,
  buildNavChords,
  shouldSuppressShortcut,
  type NavChord,
  type SuppressionContext,
} from "./shortcuts-model.js";

const GROUPS = [
  {
    items: [
      { href: "/ops", label: "Dashboard" },
      { href: "/ops/typing", label: "Typing" },
      { href: "/ops/pv1", label: "PV1 verification" },
    ],
  },
  {
    items: [{ href: "/ops/shipping", label: "Shipping" }],
  },
];

const CHORDS: ReadonlyArray<NavChord> = buildNavChords(GROUPS);

function ctx(overrides: Partial<SuppressionContext> = {}): SuppressionContext {
  return {
    targetTag: "BODY",
    targetIsContentEditable: false,
    dialogOpen: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("buildNavChords", () => {
  it("binds only chords whose route exists in the permitted nav", () => {
    expect(CHORDS.map((c) => c.key)).toEqual(["d", "t", "v", "s"]);
  });

  it("drops fill/final/orders/reports when the nav does not include them", () => {
    const keys = new Set(CHORDS.map((c) => c.key));
    expect(keys.has("f")).toBe(false);
    expect(keys.has("n")).toBe(false);
    expect(keys.has("o")).toBe(false);
    expect(keys.has("r")).toBe(false);
  });

  it("labels chords with the nav item's wording", () => {
    expect(CHORDS.find((c) => c.key === "v")).toEqual({
      key: "v",
      href: "/ops/pv1",
      label: "PV1 verification",
    });
  });

  it("returns nothing for an operator with no nav at all", () => {
    expect(buildNavChords([])).toEqual([]);
  });
});

describe("advanceChord", () => {
  it("completes a chord inside the time window", () => {
    const opened = advanceChord(null, "g", 1_000, CHORDS);
    expect(opened.state).toEqual({ pendingAt: 1_000 });
    expect(opened.consumed).toBe(true);
    expect(opened.matched).toBeNull();

    const done = advanceChord(opened.state, "t", 1_000 + CHORD_WINDOW_MS, CHORDS);
    expect(done.matched?.href).toBe("/ops/typing");
    expect(done.consumed).toBe(true);
    expect(done.state).toBeNull();
  });

  it("does not complete a chord after the window elapses", () => {
    const opened = advanceChord(null, "g", 1_000, CHORDS);
    const late = advanceChord(opened.state, "t", 1_000 + CHORD_WINDOW_MS + 1, CHORDS);
    expect(late.matched).toBeNull();
    expect(late.consumed).toBe(false);
    expect(late.state).toBeNull();
  });

  it("leaves an unbound second key for other handlers", () => {
    const opened = advanceChord(null, "g", 0, CHORDS);
    // "f" is in the vocabulary but not permitted here — must not match.
    const miss = advanceChord(opened.state, "f", 100, CHORDS);
    expect(miss.matched).toBeNull();
    expect(miss.consumed).toBe(false);
    expect(miss.state).toBeNull();
  });

  it("does not match a second key with no pending prefix", () => {
    const result = advanceChord(null, "d", 0, CHORDS);
    expect(result.matched).toBeNull();
    expect(result.consumed).toBe(false);
  });

  it("re-opens the window when g is pressed mid-chord", () => {
    const first = advanceChord(null, "g", 0, CHORDS);
    const second = advanceChord(first.state, "g", 700, CHORDS);
    expect(second.state).toEqual({ pendingAt: 700 });
    const done = advanceChord(second.state, "d", 700 + CHORD_WINDOW_MS, CHORDS);
    expect(done.matched?.href).toBe("/ops");
  });
});

describe("shouldSuppressShortcut", () => {
  it("allows a plain key on the page body", () => {
    expect(shouldSuppressShortcut(ctx())).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("suppresses while focus is in a %s", (tag) => {
    expect(shouldSuppressShortcut(ctx({ targetTag: tag }))).toBe(true);
  });

  it("suppresses inside contenteditable regions", () => {
    expect(shouldSuppressShortcut(ctx({ targetIsContentEditable: true }))).toBe(true);
  });

  it("suppresses while the palette or any modal dialog is open", () => {
    expect(shouldSuppressShortcut(ctx({ dialogOpen: true }))).toBe(true);
  });

  it("suppresses modifier combos (⌘K belongs to the palette)", () => {
    expect(shouldSuppressShortcut(ctx({ metaKey: true }))).toBe(true);
    expect(shouldSuppressShortcut(ctx({ ctrlKey: true }))).toBe(true);
    expect(shouldSuppressShortcut(ctx({ altKey: true }))).toBe(true);
  });

  it("does not suppress shift — ? is Shift+/", () => {
    expect(shouldSuppressShortcut(ctx({ targetTag: "DIV" }))).toBe(false);
  });
});
