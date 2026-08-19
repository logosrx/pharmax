// Operator telemetry pruner tests.
//
// The load-bearing assertion here is that a retention cutoff is
// actually applied to BOTH tables. Presence and activity are the only
// tables written at operator-interaction rate; a pruner that silently
// swept nothing (or swept one table and not the other) would look
// healthy in logs and show up as unbounded growth a year later.

import { clock, logger } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  createOperatorTelemetryPruner,
  type PruneOperatorTelemetryDeps,
} from "./prune-operator-telemetry.js";

const FROZEN_NOW = new Date("2026-06-01T14:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60_000;

interface FindManyCall {
  readonly where: Record<string, unknown>;
  readonly take: number;
}
interface DeleteManyCall {
  readonly where: Record<string, unknown>;
}

function buildFake(input: {
  readonly staleSlotIds?: ReadonlyArray<string>;
  readonly staleEventIds?: ReadonlyArray<string>;
}): {
  client: PruneOperatorTelemetryDeps["client"];
  slotFinds: FindManyCall[];
  slotDeletes: DeleteManyCall[];
  eventFinds: FindManyCall[];
  eventDeletes: DeleteManyCall[];
} {
  const slotFinds: FindManyCall[] = [];
  const slotDeletes: DeleteManyCall[] = [];
  const eventFinds: FindManyCall[] = [];
  const eventDeletes: DeleteManyCall[] = [];
  const staleSlotIds = input.staleSlotIds ?? [];
  const staleEventIds = input.staleEventIds ?? [];

  const client = {
    operatorPresenceSlot: {
      findMany: vi.fn(async (args: FindManyCall) => {
        slotFinds.push(args);
        return staleSlotIds.map((id) => ({ id }));
      }),
      deleteMany: vi.fn(async (args: DeleteManyCall) => {
        slotDeletes.push(args);
        return { count: staleSlotIds.length };
      }),
    },
    operatorActivityEvent: {
      findMany: vi.fn(async (args: FindManyCall) => {
        eventFinds.push(args);
        return staleEventIds.map((id) => ({ id }));
      }),
      deleteMany: vi.fn(async (args: DeleteManyCall) => {
        eventDeletes.push(args);
        return { count: staleEventIds.length };
      }),
    },
  } as unknown as PruneOperatorTelemetryDeps["client"];

  return { client, slotFinds, slotDeletes, eventFinds, eventDeletes };
}

function build(
  fake: ReturnType<typeof buildFake>,
  options: { retentionDays?: number; batchSize?: number } = {}
) {
  return createOperatorTelemetryPruner(
    {
      client: fake.client,
      logger: logger.noopLogger,
      clock: clock.createFrozenClock(FROZEN_NOW),
    },
    { retentionDays: options.retentionDays ?? 90, batchSize: options.batchSize ?? 500 }
  );
}

describe("createOperatorTelemetryPruner — retention bound", () => {
  /**
   * The guard against unbounded growth. If this predicate ever went
   * missing the sweep would still "succeed" and log nothing unusual,
   * while both tables grew forever.
   */
  it("applies a retention cutoff to BOTH telemetry tables", async () => {
    const fake = buildFake({ staleSlotIds: ["s1"], staleEventIds: ["e1"] });
    const result = await build(fake, { retentionDays: 90 }).tick();

    const expectedCutoff = new Date(FROZEN_NOW.getTime() - 90 * MS_PER_DAY);
    expect(result.cutoff.toISOString()).toBe(expectedCutoff.toISOString());

    expect(fake.slotFinds).toHaveLength(1);
    expect(fake.slotFinds[0]!.where).toEqual({ slotStartedAt: { lt: expectedCutoff } });

    expect(fake.eventFinds).toHaveLength(1);
    expect(fake.eventFinds[0]!.where).toEqual({ occurredAt: { lt: expectedCutoff } });
  });

  it("moves the cutoff with the configured retention window", async () => {
    const fake = buildFake({ staleSlotIds: [], staleEventIds: [] });
    const result = await build(fake, { retentionDays: 30 }).tick();
    expect(result.cutoff.toISOString()).toBe(
      new Date(FROZEN_NOW.getTime() - 30 * MS_PER_DAY).toISOString()
    );
  });

  it("caps each table's sweep at batchSize so a backlog cannot issue one huge DELETE", async () => {
    const fake = buildFake({ staleSlotIds: ["s1", "s2"], staleEventIds: ["e1"] });
    await build(fake, { batchSize: 250 }).tick();
    expect(fake.slotFinds[0]!.take).toBe(250);
    expect(fake.eventFinds[0]!.take).toBe(250);
  });

  it("deletes exactly the ids it selected", async () => {
    const fake = buildFake({ staleSlotIds: ["s1", "s2"], staleEventIds: ["e1", "e2", "e3"] });
    const result = await build(fake).tick();

    expect(fake.slotDeletes[0]!.where).toEqual({ id: { in: ["s1", "s2"] } });
    expect(fake.eventDeletes[0]!.where).toEqual({ id: { in: ["e1", "e2", "e3"] } });
    expect(result.presenceSlotsPruned).toBe(2);
    expect(result.activityEventsPruned).toBe(3);
  });

  it("skips the delete entirely when a table has nothing past the cutoff", async () => {
    const fake = buildFake({ staleSlotIds: [], staleEventIds: [] });
    const result = await build(fake).tick();
    expect(fake.slotDeletes).toHaveLength(0);
    expect(fake.eventDeletes).toHaveLength(0);
    expect(result).toMatchObject({ presenceSlotsPruned: 0, activityEventsPruned: 0 });
  });

  it("prunes one table even when the other is clean", async () => {
    const fake = buildFake({ staleSlotIds: ["s1"], staleEventIds: [] });
    const result = await build(fake).tick();
    expect(result.presenceSlotsPruned).toBe(1);
    expect(result.activityEventsPruned).toBe(0);
    expect(fake.slotDeletes).toHaveLength(1);
    expect(fake.eventDeletes).toHaveLength(0);
  });
});

describe("createOperatorTelemetryPruner — misconfiguration", () => {
  /**
   * A retention of 0 or NaN would put the cutoff at (or after) now
   * and delete live telemetry on the next tick. Refuse at
   * construction, where a boot-time crash is visible, rather than
   * silently at 3am.
   */
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses retentionDays=%s at construction",
    (retentionDays) => {
      const fake = buildFake({});
      expect(() =>
        createOperatorTelemetryPruner(
          {
            client: fake.client,
            logger: logger.noopLogger,
            clock: clock.createFrozenClock(FROZEN_NOW),
          },
          { retentionDays, batchSize: 500 }
        )
      ).toThrow(RangeError);
    }
  );

  it.each([0, -5, 1.5])("refuses batchSize=%s at construction", (batchSize) => {
    const fake = buildFake({});
    expect(() =>
      createOperatorTelemetryPruner(
        {
          client: fake.client,
          logger: logger.noopLogger,
          clock: clock.createFrozenClock(FROZEN_NOW),
        },
        { retentionDays: 90, batchSize }
      )
    ).toThrow(RangeError);
  });
});
