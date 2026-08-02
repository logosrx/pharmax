// QueueCountsBroadcaster — the in-process fan-out behind the ops
// SSE stream (ADR-0034).
//
// One broadcaster instance serves every connected operator tab.
// Subscriptions are keyed by organization; while an org has at
// least one subscriber, ONE timer polls that org's queue snapshot
// (a single `order.groupBy` — count + max(updatedAt) per workflow
// bucket) and broadcasts only when the snapshot changes. Zero
// subscribers ⇒ zero polling; the feed is torn down entirely so a
// later subscriber starts from a fresh poll.
//
// Postgres stays the only source of truth — everything here is a
// throwaway projection (ADR-0009). The `max(updatedAt)` per bucket
// is the "something moved" signal for transitions that don't change
// a count (e.g. a claim moving INBOX→TYPING is invisible to the
// summed typing-page badge but bumps `updatedAt`).
//
// PHI: counts and timestamps only; no row data leaves the database.
//
// Concurrency notes:
//   - Ticks never overlap (per-org `ticking` guard).
//   - A failing poll logs and retries on the next tick; transient
//     DB errors never kill the loop.
//   - Timers are `unref`'d so an idle broadcaster never holds the
//     process open.

import "server-only";

import { readInOrgScope, type TenantTransactionClient } from "@pharmax/database";

/** Bucket codes carried on the stream. Superset of the nav badges:
 *  SHIPPING and EMERGENCY ride along so the shipping/emergency pages
 *  and the dashboard banner can refresh off the same feed. */
export const STREAMED_BUCKET_CODES = [
  "INBOX",
  "TYPING",
  "PV1",
  "FILL",
  "FINAL",
  "SHIPPING",
  "EMERGENCY",
] as const;

export interface QueueBucketSnapshot {
  readonly count: number;
  /** ISO time of the most recent order movement in the bucket
   *  (`max(updatedAt)`); null when the bucket is empty. */
  readonly changedAt: string | null;
}

/** `bucketCode → snapshot`; null when the bucket isn't provisioned
 *  for the org. */
export type QueueCountsSnapshot = Readonly<Record<string, QueueBucketSnapshot | null>>;

export type QueueCountsListener = (snapshot: QueueCountsSnapshot) => void;

export type QueueCountsSnapshotLoader = (organizationId: string) => Promise<QueueCountsSnapshot>;

/**
 * Default loader: one bucket lookup + one `groupBy` inside one
 * tenant-scoped transaction. Strictly cheaper than the per-bucket
 * `COUNT(*)` loop the render path uses.
 */
export async function loadQueueCountsSnapshot(
  organizationId: string
): Promise<QueueCountsSnapshot> {
  return readInOrgScope(organizationId, async (tx: TenantTransactionClient) => {
    const buckets = await tx.bucket.findMany({
      where: { organizationId, code: { in: [...STREAMED_BUCKET_CODES] } },
      select: { id: true, code: true },
    });

    const grouped = await tx.order.groupBy({
      by: ["currentBucketId"],
      where: { organizationId, currentBucketId: { in: buckets.map((b) => b.id) } },
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    const byBucketId = new Map(grouped.map((g) => [g.currentBucketId, g]));

    const idByCode = new Map(buckets.map((b) => [b.code, b.id]));
    const out: Record<string, QueueBucketSnapshot | null> = {};
    for (const code of STREAMED_BUCKET_CODES) {
      const bucketId = idByCode.get(code);
      if (bucketId === undefined) {
        out[code] = null;
        continue;
      }
      const g = byBucketId.get(bucketId);
      out[code] = Object.freeze({
        count: g?._count._all ?? 0,
        changedAt: g?._max.updatedAt?.toISOString() ?? null,
      });
    }
    return Object.freeze(out);
  });
}

export interface QueueCountsBroadcasterOptions {
  /** Injectable for tests. Defaults to `loadQueueCountsSnapshot`. */
  readonly loadSnapshot?: QueueCountsSnapshotLoader;
  /** Poll cadence per org while subscribed. Default 5000 ms. */
  readonly pollIntervalMs?: number;
  /** Structured warn sink for poll failures (no default logging —
   *  the composition site injects the real logger). */
  readonly onPollError?: (organizationId: string, error: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

interface OrgFeed {
  readonly listeners: Set<QueueCountsListener>;
  timer: ReturnType<typeof setInterval> | null;
  lastSerialized: string | null;
  lastSnapshot: QueueCountsSnapshot | null;
  ticking: boolean;
}

export class QueueCountsBroadcaster {
  private readonly feeds = new Map<string, OrgFeed>();
  private readonly loadSnapshot: QueueCountsSnapshotLoader;
  private readonly pollIntervalMs: number;
  private readonly onPollError: (organizationId: string, error: unknown) => void;

  constructor(options: QueueCountsBroadcasterOptions = {}) {
    this.loadSnapshot = options.loadSnapshot ?? loadQueueCountsSnapshot;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onPollError = options.onPollError ?? (() => {});
  }

  /**
   * Register a listener for an org's queue snapshot. The listener
   * receives the cached snapshot immediately when one exists;
   * otherwise the first poll (kicked off here) delivers it.
   * Returns an unsubscribe function (idempotent).
   */
  subscribe(organizationId: string, listener: QueueCountsListener): () => void {
    let feed = this.feeds.get(organizationId);
    if (feed === undefined) {
      feed = {
        listeners: new Set(),
        timer: null,
        lastSerialized: null,
        lastSnapshot: null,
        ticking: false,
      };
      this.feeds.set(organizationId, feed);
    }
    feed.listeners.add(listener);

    if (feed.lastSnapshot !== null) {
      listener(feed.lastSnapshot);
    }

    if (feed.timer === null) {
      const timer = setInterval(() => {
        void this.tick(organizationId);
      }, this.pollIntervalMs);
      timer.unref?.();
      feed.timer = timer;
      // Immediate first poll so the first subscriber isn't blank
      // for a full interval.
      void this.tick(organizationId);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const current = this.feeds.get(organizationId);
      if (current === undefined) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        if (current.timer !== null) clearInterval(current.timer);
        this.feeds.delete(organizationId);
      }
    };
  }

  /** Subscriber count across all orgs (test/observability aid). */
  subscriberCount(): number {
    let total = 0;
    for (const feed of this.feeds.values()) total += feed.listeners.size;
    return total;
  }

  private async tick(organizationId: string): Promise<void> {
    const feed = this.feeds.get(organizationId);
    if (feed === undefined || feed.ticking) return;
    feed.ticking = true;
    try {
      const snapshot = await this.loadSnapshot(organizationId);
      // The feed may have been torn down while the poll was in
      // flight (last subscriber left) — drop the result.
      const live = this.feeds.get(organizationId);
      if (live !== feed) return;

      const serialized = JSON.stringify(snapshot);
      if (serialized === feed.lastSerialized) return;
      feed.lastSerialized = serialized;
      feed.lastSnapshot = snapshot;
      for (const listener of feed.listeners) {
        listener(snapshot);
      }
    } catch (error) {
      this.onPollError(organizationId, error);
    } finally {
      feed.ticking = false;
    }
  }
}
