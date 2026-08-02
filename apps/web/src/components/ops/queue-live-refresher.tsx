"use client";

// QueueLiveRefresher — signal-driven RSC refresh for queue pages
// (ADR-0034).
//
// Renders nothing. Watches the live queue snapshot for the bucket
// codes this page displays and calls a debounced `router.refresh()`
// when the slice changes — so rows update through the normal server
// render path (re-running the page's own tenancy + permission
// scoping) instead of shipping a duplicate row projection over the
// wire.
//
// Behavior:
//   - The FIRST live snapshot only sets the baseline (it reflects
//     the same state the page just server-rendered; refreshing on
//     it would be a wasted round trip).
//   - Refreshes are debounced to ≥3 s apart; a change arriving
//     inside the window schedules one trailing refresh.
//   - Hidden tabs never refresh; a pending change is applied when
//     the tab becomes visible again.

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { bucketsSignature, useLiveQueueCounts } from "../shell/live-queue-counts.js";

const MIN_REFRESH_GAP_MS = 3_000;

export function QueueLiveRefresher({ codes }: { readonly codes: ReadonlyArray<string> }) {
  const { buckets, live } = useLiveQueueCounts();
  const router = useRouter();

  const baseline = useRef<string | null>(null);
  const lastRefreshAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWhileHidden = useRef(false);

  const signature = bucketsSignature(buckets, codes);

  useEffect(() => {
    if (!live) return;

    if (baseline.current === null) {
      baseline.current = signature;
      return;
    }
    if (signature === baseline.current) return;
    baseline.current = signature;

    const doRefresh = () => {
      if (typeof document !== "undefined" && document.hidden) {
        pendingWhileHidden.current = true;
        return;
      }
      lastRefreshAt.current = Date.now();
      router.refresh();
    };

    const elapsed = Date.now() - lastRefreshAt.current;
    if (elapsed >= MIN_REFRESH_GAP_MS) {
      doRefresh();
    } else if (pendingTimer.current === null) {
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        doRefresh();
      }, MIN_REFRESH_GAP_MS - elapsed);
    }
  }, [signature, live, router]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && pendingWhileHidden.current) {
        pendingWhileHidden.current = false;
        lastRefreshAt.current = Date.now();
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  useEffect(
    () => () => {
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
    },
    []
  );

  return null;
}
