// Unit tests for the workflow + bucket-size scraper.
//
// These tests stub the Prisma client surface the scraper actually
// uses (`orderStageInterval.groupBy` + `$queryRaw`) so the scraper
// can be exercised without a live database. The behavior under
// test is the snapshot transition: a tick populates the gauge-
// backing maps with the right keys + values, and a subsequent
// failed tick keeps the previous snapshot rather than clearing it.

import { describe, expect, it, vi } from "vitest";

import {
  _readScraperStateForTests,
  createWorkflowBucketScraper,
} from "./workflow-bucket-scraper.js";

interface MockClient {
  orderStageInterval: { groupBy: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
}

function buildMockClient(opts: {
  queueRows: Array<{ kind: string; organizationId: string; _count: { _all: number } }>;
  emergencyRows: Array<{ organization_id: string; count: bigint }>;
  exceptionRows: Array<{ organization_id: string; count: bigint }>;
  failOn?: "groupBy" | "queryRaw";
}): MockClient {
  return {
    orderStageInterval: {
      groupBy: vi.fn(async () => {
        if (opts.failOn === "groupBy") throw new Error("simulated groupBy failure");
        return opts.queueRows;
      }),
    },
    $queryRaw: vi
      .fn()
      .mockImplementationOnce(async () => {
        if (opts.failOn === "queryRaw") throw new Error("simulated queryRaw failure");
        return opts.emergencyRows;
      })
      .mockImplementationOnce(async () => opts.exceptionRows),
  };
}

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

describe("workflow-bucket-scraper", () => {
  it("populates the gauge state from a successful tick", async () => {
    const client = buildMockClient({
      queueRows: [
        { kind: "WAIT_BEFORE_TYPING", organizationId: "org-a", _count: { _all: 7 } },
        { kind: "TYPING_ACTIVE", organizationId: "org-a", _count: { _all: 3 } },
        { kind: "PV1_ACTIVE", organizationId: "org-b", _count: { _all: 5 } },
      ],
      emergencyRows: [
        { organization_id: "org-a", count: 2n },
        { organization_id: "org-b", count: 11n },
      ],
      exceptionRows: [{ organization_id: "org-a", count: 1n }],
    });

    const scraper = createWorkflowBucketScraper({
      client: client as unknown as Parameters<typeof createWorkflowBucketScraper>[0]["client"],
      logger: NO_OP_LOGGER as unknown as Parameters<
        typeof createWorkflowBucketScraper
      >[0]["logger"],
    });

    const tally = await scraper.tick();
    expect(tally).toEqual({
      stagesObserved: 3,
      orgsWithEmergency: 2,
      orgsWithException: 1,
    });

    const state = _readScraperStateForTests();
    expect(state.queueDepth.get("WAIT_BEFORE_TYPING:org-a")).toEqual({
      stage: "WAIT_BEFORE_TYPING",
      orgId: "org-a",
      value: 7,
    });
    expect(state.queueDepth.get("PV1_ACTIVE:org-b")?.value).toBe(5);
    expect(state.emergencyBucketSize.get("org-a")).toBe(2);
    expect(state.emergencyBucketSize.get("org-b")).toBe(11);
    expect(state.exceptionBucketSize.get("org-a")).toBe(1);
  });

  it("retains the prior snapshot when a tick fails", async () => {
    // First tick succeeds with a known snapshot...
    const okClient = buildMockClient({
      queueRows: [{ kind: "FILL_ACTIVE", organizationId: "org-c", _count: { _all: 4 } }],
      emergencyRows: [{ organization_id: "org-c", count: 9n }],
      exceptionRows: [],
    });
    const scraper = createWorkflowBucketScraper({
      client: okClient as unknown as Parameters<typeof createWorkflowBucketScraper>[0]["client"],
      logger: NO_OP_LOGGER as unknown as Parameters<
        typeof createWorkflowBucketScraper
      >[0]["logger"],
    });
    await scraper.tick();
    expect(_readScraperStateForTests().emergencyBucketSize.get("org-c")).toBe(9);

    // ...second tick fails — we do NOT clear the snapshot.
    const failClient = buildMockClient({
      queueRows: [],
      emergencyRows: [],
      exceptionRows: [],
      failOn: "groupBy",
    });
    const scraper2 = createWorkflowBucketScraper({
      client: failClient as unknown as Parameters<typeof createWorkflowBucketScraper>[0]["client"],
      logger: NO_OP_LOGGER as unknown as Parameters<
        typeof createWorkflowBucketScraper
      >[0]["logger"],
    });
    const tally = await scraper2.tick();
    expect(tally.orgsWithEmergency).toBeGreaterThanOrEqual(1);
    expect(_readScraperStateForTests().emergencyBucketSize.get("org-c")).toBe(9);
  });
});
