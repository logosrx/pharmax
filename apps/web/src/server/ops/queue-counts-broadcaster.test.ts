// Contract tests for QueueCountsBroadcaster (ADR-0034). DB-free:
// the snapshot loader is injected.
//
// Invariants pinned:
//   1. The first subscriber kicks an immediate poll and receives
//      the first snapshot; later subscribers get the cached
//      snapshot synchronously.
//   2. One loader call per org per tick, regardless of listener
//      count — the whole point of the shared broadcaster.
//   3. Broadcast fires only when the snapshot CHANGES (count or
//      changedAt); identical polls are silent.
//   4. The last unsubscribe stops polling and tears the feed down;
//      a re-subscribe starts from a fresh poll.
//   5. A loader failure reports through `onPollError` and the loop
//      survives to the next tick.
//   6. Orgs are isolated: each gets its own loader calls and its
//      own snapshot.
//
// All identifiers are synthetic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueueCountsBroadcaster, type QueueCountsSnapshot } from "./queue-counts-broadcaster.js";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function snapshot(count: number, changedAt: string | null = null): QueueCountsSnapshot {
  return Object.freeze({
    INBOX: Object.freeze({ count, changedAt }),
    TYPING: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QueueCountsBroadcaster", () => {
  it("polls immediately for the first subscriber and delivers the snapshot", async () => {
    const load = vi.fn(async () => snapshot(3));
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });
    const seen: QueueCountsSnapshot[] = [];

    broadcaster.subscribe(ORG_A, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(ORG_A);
    expect(seen).toEqual([snapshot(3)]);
  });

  it("hands a later subscriber the cached snapshot synchronously, without an extra poll", async () => {
    const load = vi.fn(async () => snapshot(7));
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });

    broadcaster.subscribe(ORG_A, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    const seen: QueueCountsSnapshot[] = [];
    broadcaster.subscribe(ORG_A, (s) => seen.push(s));

    expect(seen).toEqual([snapshot(7)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(broadcaster.subscriberCount()).toBe(2);
  });

  it("stays silent when consecutive polls return the same snapshot", async () => {
    const load = vi.fn(async () => snapshot(2, "2026-07-31T00:00:00.000Z"));
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });
    const seen: QueueCountsSnapshot[] = [];

    broadcaster.subscribe(ORG_A, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(load).toHaveBeenCalledTimes(4); // initial + 3 interval ticks
    expect(seen).toHaveLength(1); // ...but only one broadcast
  });

  it("broadcasts when only changedAt moves (count-stable bucket transition)", async () => {
    const results = [
      snapshot(2, "2026-07-31T00:00:00.000Z"),
      snapshot(2, "2026-07-31T00:00:05.000Z"),
    ];
    let call = 0;
    const load = vi.fn(async () => results[Math.min(call++, results.length - 1)]!);
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });
    const seen: QueueCountsSnapshot[] = [];

    broadcaster.subscribe(ORG_A, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(seen).toHaveLength(2);
    expect(seen[1]!["INBOX"]?.changedAt).toBe("2026-07-31T00:00:05.000Z");
  });

  it("stops polling when the last subscriber leaves; a re-subscribe re-polls fresh", async () => {
    const load = vi.fn(async () => snapshot(1));
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });

    const unsubscribe = broadcaster.subscribe(ORG_A, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe(); // idempotent
    expect(broadcaster.subscriberCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1); // no polls while empty

    const seen: QueueCountsSnapshot[] = [];
    broadcaster.subscribe(ORG_A, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2); // fresh poll, no stale cache
    expect(seen).toEqual([snapshot(1)]);
  });

  it("reports loader failures and keeps the loop alive", async () => {
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("db hiccup");
      return snapshot(9);
    });
    const onPollError = vi.fn();
    const broadcaster = new QueueCountsBroadcaster({
      loadSnapshot: load,
      pollIntervalMs: 5000,
      onPollError,
    });
    const seen: QueueCountsSnapshot[] = [];

    broadcaster.subscribe(ORG_A, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(onPollError).toHaveBeenCalledTimes(1);
    expect(onPollError).toHaveBeenCalledWith(ORG_A, expect.any(Error));
    expect(seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([snapshot(9)]);
  });

  it("isolates orgs: separate polls, separate snapshots", async () => {
    const load = vi.fn(async (organizationId: string) =>
      organizationId === ORG_A ? snapshot(1) : snapshot(2)
    );
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });
    const seenA: QueueCountsSnapshot[] = [];
    const seenB: QueueCountsSnapshot[] = [];

    broadcaster.subscribe(ORG_A, (s) => seenA.push(s));
    broadcaster.subscribe(ORG_B, (s) => seenB.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(seenA).toEqual([snapshot(1)]);
    expect(seenB).toEqual([snapshot(2)]);
    expect(load).toHaveBeenCalledWith(ORG_A);
    expect(load).toHaveBeenCalledWith(ORG_B);
  });

  it("fans one poll out to every listener of the org", async () => {
    const load = vi.fn(async () => snapshot(4));
    const broadcaster = new QueueCountsBroadcaster({ loadSnapshot: load, pollIntervalMs: 5000 });
    const seen1: QueueCountsSnapshot[] = [];
    const seen2: QueueCountsSnapshot[] = [];

    broadcaster.subscribe(ORG_A, (s) => seen1.push(s));
    broadcaster.subscribe(ORG_A, (s) => seen2.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(load).toHaveBeenCalledTimes(1);
    expect(seen1).toEqual([snapshot(4)]);
    expect(seen2).toEqual([snapshot(4)]);
  });
});
