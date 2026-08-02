// GET /api/ops/queue/stream — the ops-console live-counts feed
// (ADR-0034).
//
// Server-Sent Events: the browser `EventSource` connects with the
// same-origin session cookie, we resolve the operator session
// in-handler (the middleware cookie-presence check is not auth),
// and subscribe the connection to the process-wide
// `QueueCountsBroadcaster` for the operator's org.
//
// Contract (ops-console internal, not a partner API):
//   - `event: counts` — data is a `QueueCountsSnapshot` JSON object
//     (`bucketCode → { count, changedAt } | null`). Sent once on
//     subscribe and then only when the snapshot changes.
//   - heartbeat comments every 20 s keep intermediaries from idling
//     the connection out.
//   - The server hard-closes every stream after 5 minutes; the
//     browser reconnects automatically, which re-runs session
//     resolution — so a revoked/expired session loses the feed
//     within minutes instead of holding a zombie subscription.
//
// AuthZ: counts are org-level non-PHI aggregates — the same batch
// every operator's layout already computes server-side on render —
// so any ACTIVE operator of the org may subscribe. Per-permission
// DISPLAY filtering stays in the nav (permission-gated items).
//
// PHI: counts + timestamps only. Nothing row-level rides this
// stream.

import "server-only";

import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../src/server/logger.js";
import {
  QueueCountsBroadcaster,
  type QueueCountsSnapshot,
} from "../../../../../src/server/ops/queue-counts-broadcaster.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 20_000;
const MAX_STREAM_MS = 5 * 60_000;

// Process-wide singleton (module scope survives across requests in
// one server instance; dev HMR may re-create it, in which case the
// orphaned instance's timers stop as its streams disconnect).
let broadcaster: QueueCountsBroadcaster | null = null;

function getBroadcaster(): QueueCountsBroadcaster {
  if (broadcaster === null) {
    broadcaster = new QueueCountsBroadcaster({
      onPollError: (organizationId, error) => {
        logger.warn("ops.queue_stream.poll_failed", {
          organizationId,
          errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
        });
      },
    });
  }
  return broadcaster;
}

export async function GET(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.json(
      { error: { code: "QUEUE_STREAM_NO_SESSION", message: "Sign in to subscribe." } },
      { status: 401 }
    );
  }

  const organizationId = session.tenancy.organizationId;
  const encoder = new TextEncoder();

  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;

      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat !== null) clearInterval(heartbeat);
        if (deadline !== null) clearTimeout(deadline);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime (client disconnect).
        }
      };

      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Enqueue after client disconnect — tear down.
          close();
        }
      };

      // Reconnect hint for EventSource (ms).
      write("retry: 3000\n\n");

      unsubscribe = getBroadcaster().subscribe(organizationId, (snapshot: QueueCountsSnapshot) => {
        write(`event: counts\ndata: ${JSON.stringify(snapshot)}\n\n`);
      });

      heartbeat = setInterval(() => write(": hb\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();
      deadline = setTimeout(close, MAX_STREAM_MS);
      deadline.unref?.();

      request.signal.addEventListener("abort", close);
      cleanup = close;

      if (request.signal.aborted) close();
    },
    cancel() {
      // The runtime calls this on client disconnect; the abort
      // listener normally beat us here, but belt + suspenders.
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat proxy buffering (nginx et al.) so events flush.
      "X-Accel-Buffering": "no",
    },
  });
}
