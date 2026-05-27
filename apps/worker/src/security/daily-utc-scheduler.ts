// Minimal daily-at-UTC-HH:MM scheduler.
//
// The existing `createPollLoop` runs `tick()` at a fixed interval
// (e.g. every 30s) — perfect for outbox drains, but wrong for
// once-per-day security jobs that must fire close to a specific
// UTC clock time:
//
//   - Daily Merkle root signing job: 02:00 UTC ("after the last
//     possible audit_log row for yesterday's window, but before
//     the morning's traffic warms up").
//   - Nightly security digest: 02:30 UTC (intentionally after the
//     Merkle job so today's digest reports yesterday's signed
//     manifest URI).
//
// Why not a cron daemon: the worker is the only process that runs
// reliably across all environments (no separate Kubernetes
// CronJob in dev, no AWS EventBridge in tests). Embedding a tiny
// scheduler inside the same process keeps the deployment surface
// equal to "the worker is up" — same as the outbox drainer.
//
// Why not import a third-party `node-cron`-style library: this
// scheduler does exactly ONE thing (fire at next UTC HH:MM,
// repeat) and the surface is ~80 lines including comments. A
// dependency would add a vendor risk for no functional gain.
//
// Concurrency:
//
//   - At most one `runJob` invocation in flight at a time. If a
//     job is still running when the next fire time elapses, we
//     SKIP that fire (with a structured WARN log) and the next
//     fire goes back to the regular schedule. We do NOT queue,
//     because a queue would mask a job that is silently taking
//     >24h.

import type { logger as loggerContract } from "@pharmax/platform-core";

type Logger = loggerContract.Logger;

export interface DailyUtcSchedulerOptions {
  readonly name: string;
  /** UTC hour to fire (0–23). */
  readonly utcHour: number;
  /** UTC minute to fire (0–59). */
  readonly utcMinute: number;
  readonly runJob: () => Promise<void>;
  readonly logger: Logger;
  /** Override the clock; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface DailyUtcScheduler {
  start(): void;
  stop(): Promise<void>;
}

export function createDailyUtcScheduler(options: DailyUtcSchedulerOptions): DailyUtcScheduler {
  const { name, utcHour, utcMinute, runJob, logger } = options;
  if (!Number.isInteger(utcHour) || utcHour < 0 || utcHour > 23) {
    throw new RangeError(`createDailyUtcScheduler(${name}): utcHour must be 0..23.`);
  }
  if (!Number.isInteger(utcMinute) || utcMinute < 0 || utcMinute > 59) {
    throw new RangeError(`createDailyUtcScheduler(${name}): utcMinute must be 0..59.`);
  }
  const now = options.now ?? (() => new Date());
  const log = logger.child({ component: "daily-utc-scheduler", scheduler: name });

  let stopRequested = false;
  let scheduled: NodeJS.Timeout | null = null;
  let runningJob: Promise<void> | null = null;
  let resolveStopped: (() => void) | null = null;
  let stoppedPromise: Promise<void> | null = null;

  function msUntilNextFire(): number {
    const current = now();
    const next = new Date(
      Date.UTC(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate(),
        utcHour,
        utcMinute,
        0,
        0
      )
    );
    if (next.getTime() <= current.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - current.getTime();
  }

  function scheduleNext(): void {
    if (stopRequested) return;
    const delayMs = msUntilNextFire();
    log.info("scheduler.next_fire", { delayMs, utcHour, utcMinute });
    scheduled = setTimeout(fire, delayMs);
    scheduled.unref();
  }

  function fire(): void {
    scheduled = null;
    if (stopRequested) return;
    if (runningJob !== null) {
      log.warn("scheduler.skipped_overlapping_fire", { utcHour, utcMinute });
      scheduleNext();
      return;
    }
    runningJob = (async () => {
      try {
        await runJob();
        log.info("scheduler.job_complete");
      } catch (cause) {
        log.error("scheduler.job_failed", {
          errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
        });
      } finally {
        runningJob = null;
        if (stopRequested && resolveStopped !== null) {
          resolveStopped();
          resolveStopped = null;
        } else {
          scheduleNext();
        }
      }
    })();
  }

  return {
    start(): void {
      if (stopRequested) {
        throw new Error(`daily-utc-scheduler "${name}" cannot be restarted after stop()`);
      }
      log.info("scheduler.start", { utcHour, utcMinute });
      scheduleNext();
    },
    stop(): Promise<void> {
      if (stoppedPromise !== null) return stoppedPromise;
      stopRequested = true;
      log.info("scheduler.stop_requested");
      if (scheduled !== null) {
        clearTimeout(scheduled);
        scheduled = null;
      }
      stoppedPromise = new Promise<void>((resolve) => {
        if (runningJob === null) {
          log.info("scheduler.stopped");
          resolve();
          return;
        }
        resolveStopped = () => {
          log.info("scheduler.stopped");
          resolve();
        };
      });
      return stoppedPromise;
    },
  };
}
