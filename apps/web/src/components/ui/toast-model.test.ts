// ToastStore unit tests — queue/cap, dedupe, auto-dismiss timing,
// pause/resume, and two-phase (leaving → removed) dismissal, all under
// fake timers. Synthetic strings only; no PHI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DURATION_MS,
  ERROR_DURATION_MS,
  EXIT_ANIMATION_MS,
  MAX_VISIBLE_TOASTS,
  ToastStore,
  resolveDurationMs,
} from "./toast-model.js";

describe("resolveDurationMs", () => {
  it("defaults to ~5s for non-error variants", () => {
    expect(resolveDurationMs({ variant: "success", title: "t" })).toBe(DEFAULT_DURATION_MS);
    expect(resolveDurationMs({ variant: "info", title: "t" })).toBe(DEFAULT_DURATION_MS);
    expect(resolveDurationMs({ variant: "warning", title: "t" })).toBe(DEFAULT_DURATION_MS);
  });

  it("gives errors a longer default so the detail code can be copied", () => {
    expect(resolveDurationMs({ variant: "error", title: "t" })).toBe(ERROR_DURATION_MS);
  });

  it("honours an explicit duration, including 0 (sticky)", () => {
    expect(resolveDurationMs({ variant: "error", title: "t", durationMs: 1_000 })).toBe(1_000);
    expect(resolveDurationMs({ variant: "success", title: "t", durationMs: 0 })).toBe(0);
  });
});

describe("ToastStore", () => {
  let store: ToastStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ToastStore();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it("shows a toast with normalized fields", () => {
    const id = store.show({ variant: "success", title: "Order approved" });
    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id,
      variant: "success",
      title: "Order approved",
      description: null,
      detail: null,
      durationMs: DEFAULT_DURATION_MS,
      leaving: false,
    });
  });

  it("auto-dismisses after the default duration (leaving, then removed)", () => {
    store.show({ variant: "success", title: "Done" });

    vi.advanceTimersByTime(DEFAULT_DURATION_MS - 1);
    expect(store.getSnapshot()[0]?.leaving).toBe(false);

    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()[0]?.leaving).toBe(true);

    vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("keeps error toasts up longer than success toasts", () => {
    store.show({ variant: "error", title: "Refused", detail: "PV1_APPROVE_REFUSED" });

    vi.advanceTimersByTime(DEFAULT_DURATION_MS);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]?.leaving).toBe(false);

    vi.advanceTimersByTime(ERROR_DURATION_MS - DEFAULT_DURATION_MS);
    expect(store.getSnapshot()[0]?.leaving).toBe(true);
  });

  it("never auto-dismisses a sticky toast (durationMs: 0)", () => {
    const id = store.show({ variant: "warning", title: "Printer offline", durationMs: 0 });

    vi.advanceTimersByTime(600_000);
    expect(store.getSnapshot()).toHaveLength(1);

    store.dismiss(id);
    vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("caps visible toasts and promotes the queue in FIFO order", () => {
    const ids = Array.from({ length: MAX_VISIBLE_TOASTS + 2 }, (_, i) =>
      store.show({ variant: "info", title: `Toast ${i}` })
    );

    expect(store.getSnapshot()).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(store.getSnapshot().map((t) => t.id)).toEqual(ids.slice(0, MAX_VISIBLE_TOASTS));

    const firstVisible = ids[0];
    expect(firstVisible).toBeDefined();
    store.dismiss(firstVisible as string);
    vi.advanceTimersByTime(EXIT_ANIMATION_MS);

    // Oldest queued toast took the freed slot.
    expect(store.getSnapshot()).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(store.getSnapshot().map((t) => t.id)).toEqual([
      ...ids.slice(1, MAX_VISIBLE_TOASTS),
      ids[MAX_VISIBLE_TOASTS],
    ]);
  });

  it("dedupes an identical visible toast and restarts its countdown", () => {
    const first = store.show({ variant: "success", title: "Saved", detail: "abc" });

    vi.advanceTimersByTime(DEFAULT_DURATION_MS - 1_000);
    const second = store.show({ variant: "success", title: "Saved", detail: "abc" });

    expect(second).toBe(first);
    expect(store.getSnapshot()).toHaveLength(1);

    // The countdown restarted: 1ms shy of a FULL duration later, it
    // is still up; the original deadline has long passed.
    vi.advanceTimersByTime(DEFAULT_DURATION_MS - 1);
    expect(store.getSnapshot()[0]?.leaving).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()[0]?.leaving).toBe(true);
  });

  it("does not dedupe toasts that differ in any field", () => {
    store.show({ variant: "success", title: "Saved" });
    store.show({ variant: "success", title: "Saved", detail: "order-1" });
    store.show({ variant: "info", title: "Saved" });
    expect(store.getSnapshot()).toHaveLength(3);
  });

  it("dedupes against the pending queue too", () => {
    for (let i = 0; i < MAX_VISIBLE_TOASTS; i++) {
      store.show({ variant: "info", title: `Filler ${i}` });
    }
    const queued = store.show({ variant: "error", title: "Failed" });
    const duplicate = store.show({ variant: "error", title: "Failed" });

    expect(duplicate).toBe(queued);
    expect(store.getSnapshot()).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it("can dismiss a toast that is still queued", () => {
    for (let i = 0; i < MAX_VISIBLE_TOASTS; i++) {
      store.show({ variant: "info", title: `Filler ${i}`, durationMs: 0 });
    }
    const queued = store.show({ variant: "info", title: "Queued" });
    store.dismiss(queued);

    const visible = store.getSnapshot().map((t) => t.id);
    store.dismiss(visible[0] as string);
    vi.advanceTimersByTime(EXIT_ANIMATION_MS);

    // The dismissed queued toast was never promoted.
    expect(store.getSnapshot().map((t) => t.title)).toEqual(["Filler 1", "Filler 2", "Filler 3"]);
  });

  it("pause freezes the countdown; resume continues with time remaining", () => {
    store.show({ variant: "success", title: "Hover me" });

    vi.advanceTimersByTime(3_000);
    store.pause();

    // Hovered: arbitrarily long, nothing expires.
    vi.advanceTimersByTime(120_000);
    expect(store.getSnapshot()[0]?.leaving).toBe(false);

    store.resume();
    vi.advanceTimersByTime(DEFAULT_DURATION_MS - 3_000 - 1);
    expect(store.getSnapshot()[0]?.leaving).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()[0]?.leaving).toBe(true);
  });

  it("a toast shown while paused does not start counting until resume", () => {
    store.pause();
    store.show({ variant: "info", title: "Shown under hover" });

    vi.advanceTimersByTime(60_000);
    expect(store.getSnapshot()).toHaveLength(1);

    store.resume();
    vi.advanceTimersByTime(DEFAULT_DURATION_MS + EXIT_ANIMATION_MS);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("dismissAll clears visible toasts and drops the queue", () => {
    for (let i = 0; i < MAX_VISIBLE_TOASTS + 3; i++) {
      store.show({ variant: "info", title: `Toast ${i}` });
    }
    store.dismissAll();

    expect(store.getSnapshot().every((t) => t.leaving)).toBe(true);
    vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("notifies subscribers on every change and keeps snapshots stable between changes", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.show({ variant: "success", title: "One" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    unsubscribe();
    store.show({ variant: "success", title: "Two" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
