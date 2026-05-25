// Outbox drainer tests use:
//   - A mocked `$queryRaw` to drive what the claim returns.
//   - A mocked `eventOutbox` delegate (only `update` is exercised here).
// The intent is to lock in the dispatch + mark-status state machine
// without depending on a live Postgres.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger as loggerNs } from "@pharmax/platform-core";

import { createOutboxDrainer, type ClaimedOutboxEventRow } from "./event-outbox-drainer.js";

const noopLogger = loggerNs.noopLogger;
const fixedNow = new Date("2026-05-13T12:00:00.000Z");
const clock = (): Date => fixedNow;

interface RowOverrides {
  readonly id?: string;
  readonly eventType?: string;
  readonly attempts?: number;
  readonly status?: ClaimedOutboxEventRow["status"];
}

function fakeRow(overrides: RowOverrides = {}): ClaimedOutboxEventRow {
  return Object.freeze({
    id: overrides.id ?? "outbox_1",
    organizationId: "00000000-0000-0000-0000-000000000001",
    eventType: overrides.eventType ?? "order.created",
    aggregateType: "order",
    aggregateId: "00000000-0000-0000-0000-0000000000aa",
    payload: { orderId: "00000000-0000-0000-0000-0000000000aa" },
    status: overrides.status ?? "PENDING",
    attempts: overrides.attempts ?? 1,
    lastError: null,
    nextAttemptAt: null,
    dispatchedAt: null,
    createdAt: fixedNow,
  });
}

interface FakeClient {
  $queryRaw: ReturnType<typeof vi.fn>;
  eventOutbox: {
    update: ReturnType<typeof vi.fn>;
  };
}

function makeClient(claimedRows: ClaimedOutboxEventRow[]): FakeClient {
  const $queryRaw = vi.fn().mockResolvedValue(
    claimedRows.map((row) => ({
      ...row,
      // The raw query returns Prisma-shaped fields verbatim — the row
      // type used in tests is already in that shape.
    }))
  );
  const update = vi.fn(async ({ data }) => ({ ...data }));
  return {
    $queryRaw,
    eventOutbox: { update },
  };
}

describe("createOutboxDrainer.tick", () => {
  let calls: { update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    calls = { update: vi.fn() };
  });

  it("returns zeros when no rows are claimable", async () => {
    const client = makeClient([]);

    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 0, dispatched: 0, failed: 0, dead: 0 });
    expect(client.eventOutbox.update).not.toHaveBeenCalled();
  });

  it("dispatches each row through the registered handler and marks DISPATCHED", async () => {
    const row = fakeRow({ id: "outbox_handled", eventType: "order.created" });
    const client = makeClient([row]);

    const handler = vi.fn().mockResolvedValue(undefined);
    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock, handlers: { "order.created": handler } },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0 });
    expect(handler).toHaveBeenCalledOnce();
    expect(client.eventOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox_handled" },
      data: {
        status: "DISPATCHED",
        dispatchedAt: fixedNow,
        lastError: null,
        nextAttemptAt: null,
      },
    });
  });

  it("treats unregistered event types as DISPATCHED with a warning", async () => {
    const row = fakeRow({ id: "outbox_unhandled", eventType: "no.such.event" });
    const client = makeClient([row]);

    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0 });
    expect(client.eventOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox_unhandled" },
      data: expect.objectContaining({ status: "DISPATCHED" }),
    });
  });

  it("marks FAILED with a backoff when a handler throws and attempts < max", async () => {
    const row = fakeRow({ id: "outbox_fail", attempts: 2 });
    const client = makeClient([row]);

    const drainer = createOutboxDrainer(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        logger: noopLogger,
        clock,
        handlers: {
          "order.created": vi.fn().mockRejectedValue(new Error("transient-flap")),
        },
        maxAttempts: 8,
      },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 1, dead: 0 });
    const updateCall = client.eventOutbox.update.mock.calls[0]?.[0];
    expect(updateCall?.data.status).toBe("FAILED");
    expect(updateCall?.data.lastError).toContain("transient-flap");
    expect(updateCall?.data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("marks DEAD with no retry when attempts has reached maxAttempts", async () => {
    const row = fakeRow({ id: "outbox_dead", attempts: 8 });
    const client = makeClient([row]);

    const drainer = createOutboxDrainer(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        logger: noopLogger,
        clock,
        handlers: {
          "order.created": vi.fn().mockRejectedValue(new Error("permanent")),
        },
        maxAttempts: 8,
      },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 0, dead: 1 });
    const updateCall = client.eventOutbox.update.mock.calls[0]?.[0];
    expect(updateCall?.data.status).toBe("DEAD");
    expect(updateCall?.data.nextAttemptAt).toBeNull();
  });

  it("processes a batch and tallies mixed outcomes", async () => {
    const ok = fakeRow({ id: "outbox_ok" });
    const fail = fakeRow({ id: "outbox_fail2", attempts: 3 });
    const dead = fakeRow({ id: "outbox_dead2", attempts: 8 });
    const client = makeClient([ok, fail, dead]);

    const drainer = createOutboxDrainer(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        logger: noopLogger,
        clock,
        handlers: {
          "order.created": vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("transient"))
            .mockRejectedValueOnce(new Error("permanent")),
        },
        maxAttempts: 8,
      },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 3, dispatched: 1, failed: 1, dead: 1 });
    expect(client.eventOutbox.update).toHaveBeenCalledTimes(3);
  });

  // Reference held to silence lint about unused beforeEach var; the
  // `calls` placeholder is reserved for future assertions about call
  // ordering.
  it("[meta] beforeEach scaffolding is callable", () => {
    expect(typeof calls.update).toBe("function");
  });
});
