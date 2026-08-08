// Unit tests for the outbox backlog probe.
//
// Stubs the one Prisma surface the probe uses (`$queryRaw`) and the
// metrics publisher, then asserts the contract both alarm consumers
// depend on: the aggregate row becomes exactly three datums in the
// Pharmax/Worker namespace, and ANY failure (query or publish) ends
// the tick with no datapoint rather than a crash — missing data is
// the probe's designed failure signature, because the warning-tier
// age alarm treats it as breaching.

import type { PrismaClient } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import type { MetricDatum } from "./metrics-publisher.js";
import {
  createOutboxBacklogProbe,
  OUTBOX_DEAD_DEPTH_METRIC,
  OUTBOX_OLDEST_UNDISPATCHED_AGE_METRIC,
  OUTBOX_UNDISPATCHED_DEPTH_METRIC,
  WORKER_METRIC_NAMESPACE,
} from "./outbox-backlog-probe.js";

interface NoOpLogger {
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
  fatal: () => void;
  trace: () => void;
  child: () => NoOpLogger;
}

const NO_OP_LOGGER: NoOpLogger = (() => {
  const noop = (): void => {};
  const logger: NoOpLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  return logger;
})();

function buildDeps(opts: {
  row?: {
    undispatched_depth: bigint;
    oldest_undispatched_age_seconds: number;
    dead_depth: bigint;
  };
  queryFails?: boolean;
  publishFails?: boolean;
}) {
  const published: Array<{ namespace: string; datums: ReadonlyArray<MetricDatum> }> = [];
  const client = {
    $queryRaw: vi.fn(async () => {
      if (opts.queryFails === true) throw new Error("simulated query failure");
      return [
        opts.row ?? {
          undispatched_depth: 0n,
          oldest_undispatched_age_seconds: 0,
          dead_depth: 0n,
        },
      ];
    }),
  };
  const publisher = {
    async publish(namespace: string, datums: ReadonlyArray<MetricDatum>): Promise<void> {
      if (opts.publishFails === true) throw new Error("simulated publish failure");
      published.push({ namespace, datums });
    },
  };
  return {
    published,
    probe: createOutboxBacklogProbe({
      client: client as unknown as Pick<PrismaClient, "$queryRaw">,
      logger: NO_OP_LOGGER as unknown as Parameters<typeof createOutboxBacklogProbe>[0]["logger"],
      publisher,
    }),
  };
}

describe("outbox-backlog-probe", () => {
  it("publishes the three backlog metrics from the aggregate row", async () => {
    const { probe, published } = buildDeps({
      row: {
        undispatched_depth: 7n,
        oldest_undispatched_age_seconds: 421.5,
        dead_depth: 2n,
      },
    });

    const result = await probe.tick();

    expect(result.snapshot).toEqual({
      undispatchedDepth: 7,
      oldestUndispatchedAgeSeconds: 421.5,
      deadDepth: 2,
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.namespace).toBe(WORKER_METRIC_NAMESPACE);
    expect(published[0]?.datums).toEqual([
      { metricName: OUTBOX_UNDISPATCHED_DEPTH_METRIC, value: 7, unit: "Count" },
      { metricName: OUTBOX_OLDEST_UNDISPATCHED_AGE_METRIC, value: 421.5, unit: "Seconds" },
      { metricName: OUTBOX_DEAD_DEPTH_METRIC, value: 2, unit: "Count" },
    ]);
  });

  it("reports zeros for an empty outbox (age 0, not null)", async () => {
    const { probe, published } = buildDeps({});
    const result = await probe.tick();
    expect(result.snapshot).toEqual({
      undispatchedDepth: 0,
      oldestUndispatchedAgeSeconds: 0,
      deadDepth: 0,
    });
    expect(published[0]?.datums.map((d) => d.value)).toEqual([0, 0, 0]);
  });

  it("survives a query failure: no datapoint, no throw", async () => {
    const { probe, published } = buildDeps({ queryFails: true });
    const result = await probe.tick();
    expect(result.snapshot).toBeNull();
    expect(published).toHaveLength(0);
  });

  it("survives a publish failure: no throw, snapshot reported as failed", async () => {
    const { probe } = buildDeps({
      row: { undispatched_depth: 1n, oldest_undispatched_age_seconds: 5, dead_depth: 0n },
      publishFails: true,
    });
    const result = await probe.tick();
    expect(result.snapshot).toBeNull();
  });
});
