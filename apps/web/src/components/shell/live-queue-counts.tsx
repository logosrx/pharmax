"use client";

// LiveQueueCounts — the client half of the ops live-counts feed
// (ADR-0034).
//
// One provider per operator tab (mounted in the ops layout) owns a
// single `EventSource` to `/api/ops/queue/stream` and exposes the
// latest `QueueCountsSnapshot` via context:
//
//   - Sidebar badges read it for in-place count updates.
//   - `QueueLiveRefresher` reads it to drive debounced RSC
//     refreshes on queue pages / the dashboard.
//
// The provider is seeded with the SSR-computed counts so the first
// paint matches the server render; `live` flips true on the first
// SSE snapshot (consumers that must not react to the seed key off
// it). `EventSource` reconnects automatically — including after the
// server's 5-minute stream cap — so no retry logic lives here.
//
// PHI: counts + timestamps only.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface LiveBucketSnapshot {
  readonly count: number;
  readonly changedAt: string | null;
}

/** `bucketCode → snapshot`; null = bucket not provisioned. */
export type LiveBuckets = Readonly<Record<string, LiveBucketSnapshot | null>>;

export interface LiveQueueCountsValue {
  readonly buckets: LiveBuckets;
  /** True once at least one SSE snapshot has arrived. */
  readonly live: boolean;
}

const EMPTY: LiveQueueCountsValue = Object.freeze({ buckets: Object.freeze({}), live: false });

const LiveQueueCountsContext = createContext<LiveQueueCountsValue>(EMPTY);

/**
 * Sum the live counts for a set of bucket codes. Mirrors the
 * layout's `sumCounts` semantics: unprovisioned/unknown codes are
 * skipped; null when NO code resolves (caller falls back to the
 * SSR-computed value).
 */
export function sumLiveCounts(buckets: LiveBuckets, codes: ReadonlyArray<string>): number | null {
  let total = 0;
  let any = false;
  for (const code of codes) {
    const bucket = buckets[code];
    if (bucket !== null && bucket !== undefined) {
      total += bucket.count;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Build a change signature over a set of bucket codes — count AND
 * `changedAt`, so moves that keep a summed count stable (e.g. a
 * claim moving INBOX→TYPING under a combined badge) still register.
 */
export function bucketsSignature(buckets: LiveBuckets, codes: ReadonlyArray<string>): string {
  return codes
    .map((code) => {
      const bucket = buckets[code];
      if (bucket === undefined || bucket === null) return `${code}:-`;
      return `${code}:${bucket.count}:${bucket.changedAt ?? ""}`;
    })
    .join("|");
}

export function useLiveQueueCounts(): LiveQueueCountsValue {
  return useContext(LiveQueueCountsContext);
}

export function LiveQueueCountsProvider({
  initialCounts,
  children,
}: {
  /** SSR-computed `bucketCode → count | null` seed (no `changedAt`). */
  readonly initialCounts: Readonly<Record<string, number | null>>;
  readonly children: ReactNode;
}) {
  const [value, setValue] = useState<LiveQueueCountsValue>(() => {
    const buckets: Record<string, LiveBucketSnapshot | null> = {};
    for (const [code, count] of Object.entries(initialCounts)) {
      buckets[code] = count === null ? null : { count, changedAt: null };
    }
    return { buckets: Object.freeze(buckets), live: false };
  });

  useEffect(() => {
    const source = new EventSource("/api/ops/queue/stream");
    source.addEventListener("counts", (event: MessageEvent<string>) => {
      try {
        const buckets = JSON.parse(event.data) as LiveBuckets;
        setValue({ buckets, live: true });
      } catch {
        // Malformed frame — keep the last good snapshot.
      }
    });
    // Errors (including the server's 5-minute cap) are handled by
    // EventSource's built-in reconnect; nothing to do here.
    return () => source.close();
  }, []);

  return (
    <LiveQueueCountsContext.Provider value={value}>{children}</LiveQueueCountsContext.Provider>
  );
}
