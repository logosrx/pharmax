// Outbox drainer tests use:
//   - A mocked `$queryRaw` to drive what the claim returns.
//   - A mocked `eventOutbox` delegate (`updateMany` — completion
//     writes are FENCED on the claim's attempts token).
// The intent is to lock in the dispatch + mark-status state machine
// without depending on a live Postgres.

import { describe, expect, it, vi } from "vitest";

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
    updateMany: ReturnType<typeof vi.fn>;
  };
}

function makeClient(
  claimedRows: ClaimedOutboxEventRow[],
  options: { updateManyCount?: number } = {}
): FakeClient {
  const $queryRaw = vi.fn().mockResolvedValue(claimedRows.map((row) => ({ ...row })));
  const updateMany = vi.fn(async () => ({ count: options.updateManyCount ?? 1 }));
  return {
    $queryRaw,
    eventOutbox: { updateMany },
  };
}

describe("createOutboxDrainer.tick", () => {
  it("returns zeros when no rows are claimable", async () => {
    const client = makeClient([]);

    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 0, dispatched: 0, failed: 0, dead: 0, leaseLost: 0 });
    expect(client.eventOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("dispatches each row through the registered handler and marks DISPATCHED (fenced on attempts)", async () => {
    const row = fakeRow({ id: "outbox_handled", eventType: "order.created", attempts: 3 });
    const client = makeClient([row]);

    const handler = vi.fn().mockResolvedValue(undefined);
    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock, handlers: { "order.created": handler } },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0, leaseLost: 0 });
    expect(handler).toHaveBeenCalledOnce();
    // The completion write carries the claim-time attempts as a
    // fence so a re-claimed row can't be overwritten by this worker.
    expect(client.eventOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox_handled", attempts: 3 },
      data: {
        status: "DISPATCHED",
        dispatchedAt: fixedNow,
        lastError: null,
        nextAttemptAt: null,
      },
    });
  });

  it("treats unregistered NON-required event types as DISPATCHED with a warning", async () => {
    const row = fakeRow({ id: "outbox_unhandled", eventType: "no.such.event" });
    const client = makeClient([row]);

    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0, leaseLost: 0 });
    expect(client.eventOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox_unhandled", attempts: 1 },
      data: expect.objectContaining({ status: "DISPATCHED" }),
    });
  });

  it("FAILS (retry path) when a REQUIRED event type has no handler — never a silent success", async () => {
    // Regression: emergency-escalation events were produced with no
    // consumer and the drainer marked them DISPATCHED — the alert
    // silently vanished with no replay path.
    const row = fakeRow({
      id: "outbox_required_unhandled",
      eventType: "order.escalated_to_emergency.v1",
      attempts: 1,
    });
    const client = makeClient([row]);

    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();

    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 1, dead: 0, leaseLost: 0 });
    const updateCall = client.eventOutbox.updateMany.mock.calls[0]?.[0];
    expect(updateCall?.data.status).toBe("FAILED");
    expect(updateCall?.data.lastError).toContain("REQUIRED");
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

    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 1, dead: 0, leaseLost: 0 });
    const updateCall = client.eventOutbox.updateMany.mock.calls[0]?.[0];
    expect(updateCall?.where).toEqual({ id: "outbox_fail", attempts: 2 });
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

    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 0, dead: 1, leaseLost: 0 });
    const updateCall = client.eventOutbox.updateMany.mock.calls[0]?.[0];
    expect(updateCall?.data.status).toBe("DEAD");
    expect(updateCall?.data.nextAttemptAt).toBeNull();
  });

  it("counts leaseLost (and does NOT claim success) when the fenced completion matches no row", async () => {
    // Simulates: this worker's handler outlived the lease, another
    // worker re-claimed the row (bumping attempts), so this worker's
    // completion update matches zero rows.
    const row = fakeRow({ id: "outbox_slow", attempts: 1 });
    const client = makeClient([row], { updateManyCount: 0 });

    const handler = vi.fn().mockResolvedValue(undefined);
    const drainer = createOutboxDrainer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, logger: noopLogger, clock, handlers: { "order.created": handler } },
      { batchSize: 25, leaseMs: 60_000 }
    );

    const result = await drainer.tick();
    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 0, dead: 0, leaseLost: 1 });
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
    expect(result).toEqual({ claimed: 3, dispatched: 1, failed: 1, dead: 1, leaseLost: 0 });
    expect(client.eventOutbox.updateMany).toHaveBeenCalledTimes(3);
  });
});
