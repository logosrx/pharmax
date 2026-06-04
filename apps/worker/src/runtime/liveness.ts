// Worker liveness marker.
//
// The worker is a polling drain with no HTTP socket, so ECS/Fargate
// health-checks it by testing for a marker file:
//
//   test -f /tmp/pharmax-worker-alive   (infra/terraform/modules/ecs/main.tf)
//
// Nothing previously created that file, so the worker's container health
// check could never pass and ECS would kill the task. This heartbeat:
//
//   1. Writes the marker once the drains are running, so the container
//      becomes healthy as soon as it has actually booted.
//   2. Re-touches the marker on an interval (writing a fresh ISO
//      timestamp) so a future freshness-based check (`find -mmin`) can
//      detect a wedged event loop without changing this contract.
//   3. Removes the marker on graceful shutdown, so a draining task fails
//      its health check immediately rather than lingering as "healthy".
//
// The fs calls are injectable so the behaviour is unit-testable without
// touching the real filesystem.

import { unlink, writeFile } from "node:fs/promises";

import type { logger as loggerContract } from "@pharmax/platform-core";

type Logger = loggerContract.Logger;

/**
 * Default marker path. MUST match the `healthCheck.command` for the
 * worker task definition in `infra/terraform/modules/ecs/main.tf`.
 */
export const WORKER_LIVENESS_MARKER_PATH = "/tmp/pharmax-worker-alive";

const DEFAULT_HEARTBEAT_MS = 10_000;

export interface LivenessHeartbeatOptions {
  readonly logger: Logger;
  /** Override the marker path. Defaults to {@link WORKER_LIVENESS_MARKER_PATH}. */
  readonly filePath?: string;
  /** How often to re-touch the marker. Defaults to 10s. */
  readonly intervalMs?: number;
  /** Injection seam (tests). Defaults to `fs.writeFile`. */
  readonly writeMarker?: (filePath: string, contents: string) => Promise<void>;
  /** Injection seam (tests). Defaults to `fs.unlink`, swallowing ENOENT. */
  readonly removeMarker?: (filePath: string) => Promise<void>;
  /** Injection seam (tests). Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface LivenessHeartbeat {
  /** Write the marker immediately, then start the re-touch interval. */
  start(): Promise<void>;
  /** Stop the interval and remove the marker. Idempotent. */
  stop(): Promise<void>;
}

export function createLivenessHeartbeat(options: LivenessHeartbeatOptions): LivenessHeartbeat {
  const filePath = options.filePath ?? WORKER_LIVENESS_MARKER_PATH;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? ((): Date => new Date());
  const writeMarker =
    options.writeMarker ?? ((p, c): Promise<void> => writeFile(p, c, { encoding: "utf8" }));
  const removeMarker =
    options.removeMarker ??
    (async (p): Promise<void> => {
      try {
        await unlink(p);
      } catch (cause) {
        // ENOENT just means the marker was never written or already
        // gone — that is the desired post-condition, not an error.
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          throw cause;
        }
      }
    });
  const log = options.logger.child({ component: "liveness-heartbeat" });

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function touch(): Promise<void> {
    try {
      await writeMarker(filePath, now().toISOString());
    } catch (cause) {
      // A failed touch is logged but never fatal — the heartbeat must
      // not be able to crash the worker process.
      log.error("liveness.touch.failed", {
        errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
      });
    }
  }

  return {
    async start(): Promise<void> {
      log.info("liveness.start", { filePath, intervalMs });
      await touch();
      timer = setInterval(() => {
        void touch();
      }, intervalMs);
      // The heartbeat timer must never keep the process alive on its
      // own — shutdown is gated by the drain loops, not this timer.
      timer.unref();
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await removeMarker(filePath);
      log.info("liveness.stopped");
    },
  };
}
