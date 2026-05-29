// Reaper tests.
//
// The reaper is a single `updateMany` with a deterministic WHERE
// predicate. Tests assert:
//   - cutoff = now - runtimeCeilingMs is computed correctly
//   - the WHERE filter targets only IN_PROGRESS rows past the cutoff
//   - the SET clause writes status=FAILED + completedAt + the
//     structured errorMetadata blob
//   - the reaper returns the count from Prisma's updateMany result
//   - zero-row sweeps don't log warn-level noise

import { clock, logger } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  createStuckNpiSyncRunReaper,
  type ReapStuckNpiSyncRunsDeps,
} from "./reap-stuck-npi-sync-runs.js";

const FROZEN_NOW = new Date("2026-05-28T16:00:00.000Z");

interface UpdateManyCall {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

function buildFake(count: number): {
  client: ReapStuckNpiSyncRunsDeps["client"];
  calls: UpdateManyCall[];
} {
  const calls: UpdateManyCall[] = [];
  const client = {
    providerSyncRun: {
      updateMany: vi.fn(async (args: UpdateManyCall) => {
        calls.push(args);
        return { count };
      }),
    },
  } as unknown as ReapStuckNpiSyncRunsDeps["client"];
  return { client, calls };
}

function buildFrozenClock(): ReapStuckNpiSyncRunsDeps["clock"] {
  return clock.createFrozenClock(FROZEN_NOW);
}

describe("createStuckNpiSyncRunReaper — happy path", () => {
  it("reaps stuck rows with status=FAILED and a structured errorMetadata blob", async () => {
    const fake = buildFake(3);
    const reaper = createStuckNpiSyncRunReaper(
      { client: fake.client, logger: logger.noopLogger, clock: buildFrozenClock() },
      { runtimeCeilingMs: 3_600_000 } // 60 minutes
    );

    const result = await reaper.tick();
    expect(result).toEqual({ reapedCount: 3 });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.where).toMatchObject({ status: "IN_PROGRESS" });
    expect((call.where["startedAt"] as { lt: Date }).lt).toEqual(
      new Date(FROZEN_NOW.getTime() - 3_600_000)
    );

    expect(call.data).toMatchObject({
      status: "FAILED",
      completedAt: FROZEN_NOW,
      errorMessage: "sync run exceeded runtime ceiling",
    });
    const errorMetadata = call.data["errorMetadata"] as Record<string, unknown>;
    expect(errorMetadata).toMatchObject({
      reaper: true,
      runtimeCeilingMs: 3_600_000,
      reapedAt: FROZEN_NOW.toISOString(),
    });
  });
});

describe("createStuckNpiSyncRunReaper — no-op", () => {
  it("returns 0 when no rows are stuck and does not log noisily", async () => {
    const fake = buildFake(0);
    const warnSpy = vi.fn();
    // Build a logger whose `child()` chain ultimately exposes a
    // spied `warn`. The reaper does `deps.logger.child({...}).warn(...)`.
    const childLogger: typeof logger.noopLogger = {
      ...logger.noopLogger,
      warn: warnSpy,
    };
    const rootLogger = {
      ...logger.noopLogger,
      child: () => childLogger,
    } satisfies typeof logger.noopLogger;

    const reaper = createStuckNpiSyncRunReaper(
      {
        client: fake.client,
        logger: rootLogger,
        clock: clock.systemClock,
      },
      { runtimeCeilingMs: 3_600_000 }
    );

    const result = await reaper.tick();
    expect(result).toEqual({ reapedCount: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("createStuckNpiSyncRunReaper — cutoff math", () => {
  it("threads runtimeCeilingMs into the cutoff predicate", async () => {
    const fake = buildFake(1);
    const reaper = createStuckNpiSyncRunReaper(
      { client: fake.client, logger: logger.noopLogger, clock: buildFrozenClock() },
      { runtimeCeilingMs: 60_000 } // 1 minute
    );

    await reaper.tick();
    const call = fake.calls[0]!;
    expect((call.where["startedAt"] as { lt: Date }).lt).toEqual(
      new Date(FROZEN_NOW.getTime() - 60_000)
    );
  });
});
