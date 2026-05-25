// Generic polling-loop runtime.
//
// Each drainer (Stripe webhooks, event outbox, future cron-style work)
// runs as one of these. Responsibilities:
//   - Invoke `tick()` at most once per `intervalMs` (no overlapping
//     ticks; if a tick is slow, the next interval starts when it ends).
//   - On error, log and apply `errorBackoffMs` before the next tick so
//     a flapping DB or downstream doesn't spam logs at full speed.
//   - On `stop()`, finish the in-flight tick, then resolve. The caller
//     (main.ts) gates process exit on this resolution so a row mid-
//     process is allowed to finalize before we shut down.
//
// `tick()` is expected to do its OWN per-row error handling (drainers
// catch and convert dispatcher failures to `markFailed` writes). The
// try/catch here is the safety net for infrastructure errors that
// escape the drainer (e.g., DB connection lost).

import type { logger as loggerContract } from "@pharmax/platform-core";

type Logger = loggerContract.Logger;

export interface PollLoopOptions {
  readonly name: string;
  readonly intervalMs: number;
  readonly errorBackoffMs?: number;
  readonly tick: () => Promise<void>;
  readonly logger: Logger;
}

export interface PollLoop {
  start(): void;
  stop(): Promise<void>;
}

const DEFAULT_ERROR_BACKOFF_MS = 5_000;

export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { name, intervalMs, tick, logger } = options;
  const errorBackoffMs = options.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS;
  const log = logger.child({ component: "poll-loop", loop: name });

  let stopRequested = false;
  let runningTick: Promise<void> | null = null;
  let scheduled: NodeJS.Timeout | null = null;
  let resolveStopped: (() => void) | null = null;
  let stoppedPromise: Promise<void> | null = null;

  function scheduleNext(delayMs: number): void {
    if (stopRequested) {
      return;
    }
    scheduled = setTimeout(runTick, delayMs);
    // Long-poll loops must not block process exit on their own — the
    // shutdown sequence is what gates exit. unref() lets ctrl-C work
    // cleanly even if signals are not wired (e.g., in tests).
    scheduled.unref();
  }

  function runTick(): void {
    if (stopRequested) {
      return;
    }
    runningTick = (async () => {
      try {
        await tick();
        if (!stopRequested) {
          scheduleNext(intervalMs);
        }
      } catch (cause) {
        log.error("poll-loop.tick.unhandled_error", {
          errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
        });
        if (!stopRequested) {
          scheduleNext(errorBackoffMs);
        }
      } finally {
        runningTick = null;
        if (stopRequested && resolveStopped !== null) {
          resolveStopped();
          resolveStopped = null;
        }
      }
    })();
  }

  return {
    start(): void {
      if (stopRequested) {
        throw new Error(`poll-loop "${name}" cannot be restarted after stop()`);
      }
      log.info("poll-loop.start", { intervalMs });
      // Run the first tick immediately so the worker is "live" the
      // moment it boots, rather than after one full interval.
      runTick();
    },
    stop(): Promise<void> {
      if (stoppedPromise !== null) {
        return stoppedPromise;
      }
      stopRequested = true;
      log.info("poll-loop.stop_requested");
      if (scheduled !== null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      stoppedPromise = new Promise<void>((resolve) => {
        if (runningTick === null) {
          log.info("poll-loop.stopped");
          resolve();
          return;
        }
        resolveStopped = () => {
          log.info("poll-loop.stopped");
          resolve();
        };
      });
      return stoppedPromise;
    },
  };
}
