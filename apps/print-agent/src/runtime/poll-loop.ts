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
