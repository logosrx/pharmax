// Mirror of apps/worker/src/runtime/liveness.test.ts for the print-agent
// marker. Locks in: immediate write on start, interval re-touch, stop
// clears the interval + removes the marker, idempotent stop, and a failing
// write is logged (not thrown).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger as loggerNs } from "@pharmax/platform-core";

import { createLivenessHeartbeat, PRINT_AGENT_LIVENESS_MARKER_PATH } from "./liveness.js";

const noopLogger = loggerNs.noopLogger;

describe("createLivenessHeartbeat (print-agent)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the marker immediately on start with an ISO timestamp", async () => {
    const writeMarker = vi.fn().mockResolvedValue(undefined);
    const removeMarker = vi.fn().mockResolvedValue(undefined);

    const heartbeat = createLivenessHeartbeat({
      logger: noopLogger,
      filePath: "/tmp/test-print-alive",
      intervalMs: 1_000,
      writeMarker,
      removeMarker,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await heartbeat.start();

    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(writeMarker).toHaveBeenCalledWith("/tmp/test-print-alive", "2026-01-01T00:00:00.000Z");

    await heartbeat.stop();
  });

  it("re-touches the marker on each interval", async () => {
    const writeMarker = vi.fn().mockResolvedValue(undefined);
    const removeMarker = vi.fn().mockResolvedValue(undefined);

    const heartbeat = createLivenessHeartbeat({
      logger: noopLogger,
      intervalMs: 1_000,
      writeMarker,
      removeMarker,
    });

    await heartbeat.start();
    expect(writeMarker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(writeMarker).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(writeMarker).toHaveBeenCalledTimes(3);

    await heartbeat.stop();
  });

  it("defaults the marker path to the ECS-contracted location", async () => {
    const writeMarker = vi.fn().mockResolvedValue(undefined);

    const heartbeat = createLivenessHeartbeat({
      logger: noopLogger,
      writeMarker,
      removeMarker: vi.fn().mockResolvedValue(undefined),
    });

    await heartbeat.start();

    expect(writeMarker).toHaveBeenCalledWith(PRINT_AGENT_LIVENESS_MARKER_PATH, expect.any(String));

    await heartbeat.stop();
  });

  it("stops the interval and removes the marker on stop()", async () => {
    const writeMarker = vi.fn().mockResolvedValue(undefined);
    const removeMarker = vi.fn().mockResolvedValue(undefined);

    const heartbeat = createLivenessHeartbeat({
      logger: noopLogger,
      intervalMs: 1_000,
      writeMarker,
      removeMarker,
    });

    await heartbeat.start();
    await heartbeat.stop();

    expect(removeMarker).toHaveBeenCalledTimes(1);

    const writesAtStop = writeMarker.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeMarker).toHaveBeenCalledTimes(writesAtStop);
  });

  it("is idempotent across repeated stop() calls", async () => {
    const removeMarker = vi.fn().mockResolvedValue(undefined);

    const heartbeat = createLivenessHeartbeat({
      logger: noopLogger,
      writeMarker: vi.fn().mockResolvedValue(undefined),
      removeMarker,
    });

    await heartbeat.start();
    await heartbeat.stop();
    await heartbeat.stop();

    expect(removeMarker).toHaveBeenCalledTimes(1);
  });

  it("logs but does not throw when a write fails", async () => {
    const error = vi.fn();
    const child = { info: vi.fn(), error, warn: vi.fn(), debug: vi.fn() };
    const spyLogger = {
      child: vi.fn(() => child),
    } as unknown as Parameters<typeof createLivenessHeartbeat>[0]["logger"];

    const heartbeat = createLivenessHeartbeat({
      logger: spyLogger,
      writeMarker: vi.fn().mockRejectedValue(new Error("disk full")),
      removeMarker: vi.fn().mockResolvedValue(undefined),
    });

    await expect(heartbeat.start()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "liveness.touch.failed",
      expect.objectContaining({ errorMessage: expect.stringContaining("disk full") })
    );

    await heartbeat.stop();
  });
});
