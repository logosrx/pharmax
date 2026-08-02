# 0034 — Real-time queue push over SSE

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Platform team
- **Tags:** `ops-console`, `queues`, `sse`, `performance`

## Context

ADR-0031's P1 milestone list includes "real-time queue push — SSE
(or WebSocket) subscriptions for ops queue views and counters,
replacing per-render `COUNT(*)`; counters move to Redis when
measurement justifies."

Today the operator console computes queue depth synchronously during
React Server Component render:

- `OpsLayout` runs `getQueueCounts()` (one indexed `COUNT(*)` per
  nav bucket inside one tenant transaction) on every `/ops/**`
  render for the sidebar badges.
- The `/ops` dashboard runs the same batch again for its stat tiles
  and pipeline strip.
- Queue pages (`/ops/typing`, `/ops/pv1`, `/ops/fill`, `/ops/final`,
  `/ops/shipping`, `/ops/emergency`) hydrate rows per render and
  never update until the operator navigates or manually reloads.

An operator staring at a queue page sees a stale list; N open tabs
each pay their own count queries; and there is no way for the
console to reflect another operator's claim without a full reload.

Constraints inherited from prior decisions:

- **ADR-0009:** `event_outbox` (DB polling) is the durable event
  channel; Redis is never a source of truth for domain events.
  Anything "live" must be a disposable projection.
- **ADR-0031:** "nothing goes distributed until a measurement forces
  it"; the milestone item itself defers Redis counters until
  measurement justifies them.
- The web tier is stock Next.js App Router (`next start`, no custom
  server). `proxy.ts` middleware only checks cookie presence;
  authoritative auth is in-handler via
  `resolveOperatorTenancyContext()`.
- There is no existing SSE/WebSocket/Redis-pub-sub infrastructure
  anywhere in the repo.

## Decision

### 1. SSE, not WebSockets

The console's real-time need is strictly server→client (counts and
"something changed" signals). SSE gives that with plain HTTP: the
browser `EventSource` sends the same-origin session cookie (so the
existing opaque-cookie auth works unchanged), auto-reconnects with
backoff for free, and needs no new protocol surface, no upgrade
handling, and no client library. WebSockets buy bidirectionality we
don't need — commands already flow through POST routes — and don't
fit `next start` without a custom server.

### 2. One in-process broadcaster; one poll per org per tick

A module-singleton `QueueCountsBroadcaster` in the web tier owns all
SSE subscriptions, keyed by organization:

- While an org has ≥ 1 subscriber, one timer polls that org's queue
  snapshot every 5 s. Zero subscribers ⇒ zero polling.
- The snapshot is ONE `order.groupBy(currentBucketId)` returning
  `{count, max(updatedAt)}` per workflow bucket (INBOX, TYPING, PV1,
  FILL, FINAL, SHIPPING, EMERGENCY) — cheaper than today's
  per-bucket `COUNT(*)` loop, and `max(updatedAt)` doubles as a
  change signal for moves that don't change a count (e.g. a claim
  moving INBOX→TYPING is invisible to the summed typing-page badge
  but bumps `updatedAt`).
- Broadcast only on change (serialized-snapshot comparison), plus an
  immediate snapshot to every new subscriber.
- Overlapping ticks are guarded; a failing poll logs and retries on
  the next tick (transient DB errors never kill the loop).

This replaces per-render, per-tab count queries with one query per
org per 5 s regardless of how many operators/tabs are connected —
strictly less DB load than N tabs × navigations, with bounded
staleness. Postgres remains the only source of truth; the
broadcaster state is a throwaway cache.

**Redis counters are still deferred**, per the milestone's own
"when measurement justifies" clause. The broadcaster is in-process,
which is correct for the current single-instance web deployment. The
day the web tier scales horizontally, the broadcaster's fan-in moves
to Redis pub/sub (each instance still polls or one instance
publishes) without touching the SSE route or client contract — the
seam is the broadcaster interface.

### 3. The stream: `GET /api/ops/queue/stream`

Node-runtime route handler returning `text/event-stream`:

- Auth: `resolveOperatorTenancyContext()` in-handler (401 without a
  valid operator session). Counts are org-level non-PHI aggregates —
  the same data every operator's layout already computes server-side
  today — so any ACTIVE operator of the org may subscribe;
  per-permission _display_ filtering stays where it is (nav items
  are permission-gated).
- Heartbeat comment every 20 s (keeps intermediaries from idling the
  connection out); `Cache-Control: no-cache, no-transform` and
  `X-Accel-Buffering: no` to defeat proxy buffering.
- Hard connection cap of 5 minutes: the server ends the stream and
  the browser's `EventSource` reconnects automatically — which
  re-runs session resolution, so a revoked/expired session loses its
  feed within minutes rather than holding a zombie subscription.

### 4. Client: live badges + signal-driven RSC refresh

- A `LiveQueueCountsProvider` client component (mounted once in the
  ops layout, seeded with the SSR-computed counts) owns the single
  `EventSource` per tab and exposes the latest snapshot via context.
- Sidebar badges consume the context — counts update in place with
  no navigation.
- Queue pages and the dashboard mount a `QueueLiveRefresher` that
  watches the snapshot slice for that page's bucket codes
  (count + `max(updatedAt)`) and calls a debounced
  `router.refresh()` when it changes. Rows therefore update through
  the normal RSC render path — no duplicate row-projection
  serialization over the wire, no client-side merge logic, and
  every refresh re-runs the page's own tenancy + permission scoping.
  Refreshes pause while the tab is hidden and catch up on
  visibility.

## Consequences

- Queue views and counters are now live (≤ 5 s staleness + debounce)
  with LESS database work than the static version under any
  realistic tab count.
- The SSE surface is one read-only endpoint; no OpenAPI change (it
  is an ops-console-internal contract, not a partner API).
- An in-process broadcaster means a web-tier restart drops all
  streams; `EventSource` reconnection makes that a ≤ few-seconds
  blip, acceptable for a projection.
- Multi-instance web deployment requires the Redis pub/sub seam
  noted above before it can load-balance SSE traffic; this is
  recorded as the explicit trigger for "counters move to Redis".
- Long-lived responses occupy a connection each; the 5-minute cap
  and heartbeat keep the pool churning and bounded by active
  operator tabs.

## Alternatives considered

- **Client-side polling (`setInterval` + fetch per tab).** Simpler,
  but N tabs × M pages each poll independently — strictly more DB
  and HTTP load than one shared broadcaster, and it still needs the
  same auth/route work.
- **WebSockets.** Needs a custom server or a separate service with
  `next start`; buys bidirectionality nothing here uses.
- **Postgres LISTEN/NOTIFY into the broadcaster.** Push-shaped, but
  lossy on connection drops (ADR-0009's original objection), needs a
  dedicated long-lived DB connection per web instance, and commands
  would have to NOTIFY on every bucket move. The 5 s poll is simpler
  and its cost is already below today's baseline. Revisit if the
  poll interval ever needs to approach real-time.
- **Redis-backed counters maintained by an outbox handler.**
  The eventual end-state per ADR-0022, but it adds a worker-side
  writer, Redis wiring in the worker (none exists today), and
  invalidation semantics — all before any measurement shows the
  5 s poll is insufficient. Deferred exactly as the milestone item
  prescribes.
