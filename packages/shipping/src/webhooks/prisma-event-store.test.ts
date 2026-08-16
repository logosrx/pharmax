// PrismaEasyPostWebhookEventStore contract tests (coverage-audit
// 2026-08, backfill item 4).
//
// The in-memory twin (`in-memory-event-store.test.ts`) already pins
// the store contract; these tests port those cases to the Prisma
// implementation using a fake Prisma delegate, and additionally pin
// the behavior only the Prisma store owns:
//
//   - P2002 race-on-insert → catch-and-refetch returns the existing
//     row (INSERT … ON CONFLICT DO NOTHING semantics), so two
//     concurrent deliveries of the same event id yield exactly one
//     inserted=true.
//   - Non-P2002 errors are rethrown untouched (no refetch).
//   - Terminal rows survive redelivery: a duplicate `recordReceived`
//     for a SUCCEEDED row returns that row unchanged — the dedupe is
//     what keeps delivered/failed one-way against carrier replays.
//     (The mark* methods are unconditional by documented contract;
//     the worker's FOR UPDATE SKIP LOCKED claim query is what stops
//     two drains from re-driving a terminal row.)
//
// CLEAN ROOM / PHI: synthetic payloads only, and only the PHI-free
// replay subset the ingestion choke point stores (id, description,
// result.{tracking_code,status,updated_at}).

import { Prisma, type EasyPostWebhookEvent } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import type { EasyPostTrackerWebhookPayload } from "../carriers/easypost-payload.js";

import { PrismaEasyPostWebhookEventStore } from "./prisma-event-store.js";

const NOW = new Date("2026-05-24T18:00:00.000Z");

function event(id = "evt_1", status = "in_transit"): EasyPostTrackerWebhookPayload {
  return {
    id,
    description: "tracker.updated",
    result: {
      id: "trk_xyz",
      tracking_code: "1Z999",
      status,
      updated_at: NOW.toISOString(),
    },
  } as EasyPostTrackerWebhookPayload;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`externalEventId`)",
    { code: "P2002", clientVersion: "0.0.0-test" }
  );
}

/**
 * Fake of the narrow `EasyPostWebhookEventClient` delegate surface,
 * backed by a Map keyed on `externalEventId` so the real unique
 * constraint is emulated: a second create for the same id throws the
 * same P2002 the driver would.
 */
class FakeEasyPostDelegate {
  public readonly rows = new Map<string, EasyPostWebhookEvent>();
  public createCalls = 0;
  public findUniqueCalls = 0;
  /** When set, the next create throws this instead of inserting. */
  public failNextCreateWith: unknown = null;
  /** When true, findUnique lies and returns null (deleted-under-race). */
  public findUniqueReturnsNull = false;
  private counter = 0;

  public readonly easyPostWebhookEvent = {
    create: async (args: {
      data: Prisma.EasyPostWebhookEventCreateInput;
    }): Promise<EasyPostWebhookEvent> => {
      this.createCalls += 1;
      if (this.failNextCreateWith !== null) {
        const failure = this.failNextCreateWith;
        this.failNextCreateWith = null;
        throw failure;
      }
      const data = args.data;
      if (this.rows.has(data.externalEventId)) {
        throw uniqueViolation();
      }
      this.counter += 1;
      const row = {
        id: `db-easypost-${this.counter}`,
        externalEventId: data.externalEventId,
        eventType: data.eventType,
        trackingCode: (data.trackingCode ?? null) as string | null,
        carrierStatus: (data.carrierStatus ?? null) as string | null,
        payload: data.payload,
        status: data.status,
        attempts: 0,
        lastError: null,
        receivedAt: data.receivedAt,
        signatureVerifiedAt: data.signatureVerifiedAt,
        processingStartedAt: null,
        processedAt: data.processedAt ?? null,
        nextAttemptAt: null,
      } as unknown as EasyPostWebhookEvent;
      this.rows.set(data.externalEventId, row);
      return row;
    },

    findUnique: async (args: {
      where: Prisma.EasyPostWebhookEventWhereUniqueInput;
    }): Promise<EasyPostWebhookEvent | null> => {
      this.findUniqueCalls += 1;
      if (this.findUniqueReturnsNull) return null;
      return this.rows.get(args.where.externalEventId as string) ?? null;
    },

    update: async (args: {
      where: Prisma.EasyPostWebhookEventWhereUniqueInput;
      data: Prisma.EasyPostWebhookEventUpdateInput;
    }): Promise<EasyPostWebhookEvent> => {
      const existing = this.rows.get(args.where.externalEventId as string);
      if (existing === undefined) {
        throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
          code: "P2025",
          clientVersion: "0.0.0-test",
        });
      }
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args.data)) {
        if (
          key === "attempts" &&
          typeof value === "object" &&
          value !== null &&
          "increment" in value
        ) {
          patch["attempts"] =
            (existing as unknown as { attempts: number }).attempts +
            (value as { increment: number }).increment;
        } else {
          patch[key] = value;
        }
      }
      const updated = { ...existing, ...patch } as EasyPostWebhookEvent;
      this.rows.set(args.where.externalEventId as string, updated);
      return updated;
    },
  };
}

function build(): { store: PrismaEasyPostWebhookEventStore; delegate: FakeEasyPostDelegate } {
  const delegate = new FakeEasyPostDelegate();
  return { store: new PrismaEasyPostWebhookEventStore(delegate), delegate };
}

async function seed(
  store: PrismaEasyPostWebhookEventStore,
  id: string,
  initialStatus: "PENDING" | "IGNORED" = "PENDING"
): Promise<void> {
  await store.recordReceived({
    event: event(id),
    receivedAt: NOW,
    signatureVerifiedAt: NOW,
    initialStatus,
  });
}

describe("PrismaEasyPostWebhookEventStore — ported in-memory-twin contract", () => {
  it("recordReceived returns inserted=true on first insert and inserted=false on duplicate", async () => {
    const { store } = build();
    const first = await store.recordReceived({
      event: event(),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    const second = await store.recordReceived({
      event: event(),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it("recordReceived sets processedAt for IGNORED rows", async () => {
    const { store } = build();
    const result = await store.recordReceived({
      event: event("evt_ignored_1"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "IGNORED",
    });
    expect(result.inserted).toBe(true);
    expect(result.record.status).toBe("IGNORED");
    expect(result.record.processedAt).toEqual(NOW);
  });

  it("recordReceived projects trackingCode and carrierStatus off the payload", async () => {
    const { store } = build();
    const result = await store.recordReceived({
      event: event("evt_proj_1", "delivered"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING",
    });
    expect(result.record.trackingCode).toBe("1Z999");
    expect(result.record.carrierStatus).toBe("delivered");
    expect(result.record.externalEventId).toBe("evt_proj_1");
    expect(result.record.eventType).toBe("tracker.updated");
    expect(Object.isFrozen(result.record)).toBe(true);
  });

  it("markProcessing bumps attempts and sets processingStartedAt", async () => {
    const { store } = build();
    await seed(store, "evt_proc_1");
    const processing = await store.markProcessing("evt_proc_1", NOW);
    expect(processing.status).toBe("PROCESSING");
    expect(processing.attempts).toBe(1);
    expect(processing.processingStartedAt).toEqual(NOW);
  });

  it("markSucceeded clears lastError and nextAttemptAt", async () => {
    const { store } = build();
    await seed(store, "evt_succ_1");
    await store.markFailed({
      externalEventId: "evt_succ_1",
      failedAt: NOW,
      errorMessage: "transient",
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    const result = await store.markSucceeded("evt_succ_1", NOW);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.lastError).toBeNull();
    expect(result.nextAttemptAt).toBeNull();
  });

  it("markFailed records lastError and nextAttemptAt", async () => {
    const { store } = build();
    await seed(store, "evt_fail_1");
    const nextAttempt = new Date(NOW.getTime() + 60_000);
    const result = await store.markFailed({
      externalEventId: "evt_fail_1",
      failedAt: NOW,
      errorMessage: "downstream 503",
      nextAttemptAt: nextAttempt,
    });
    expect(result.status).toBe("FAILED");
    expect(result.lastError).toBe("downstream 503");
    expect(result.nextAttemptAt).toEqual(nextAttempt);
  });

  it("findByExternalEventId returns null for unknown ids", async () => {
    const { store } = build();
    expect(await store.findByExternalEventId("missing")).toBeNull();
  });
});

describe("PrismaEasyPostWebhookEventStore — P2002 race-on-insert", () => {
  it("two concurrent recordReceived for the same event id: exactly one wins the insert, both get the same row", async () => {
    const { store, delegate } = build();
    const input = {
      event: event("evt_race_1"),
      receivedAt: NOW,
      signatureVerifiedAt: NOW,
      initialStatus: "PENDING" as const,
    };
    const [a, b] = await Promise.all([store.recordReceived(input), store.recordReceived(input)]);
    const insertedFlags = [a.inserted, b.inserted].sort();
    expect(insertedFlags).toEqual([false, true]);
    expect(a.record.id).toBe(b.record.id);
    // Both attempts hit create (the loser took the P2002 path).
    expect(delegate.createCalls).toBe(2);
  });

  it("catches P2002 and refetches the winner's row instead of surfacing the violation", async () => {
    const { store, delegate } = build();
    await seed(store, "evt_race_2");
    delegate.failNextCreateWith = uniqueViolation();
    const result = await store.recordReceived({
      event: event("evt_race_2"),
      receivedAt: new Date(NOW.getTime() + 1_000),
      signatureVerifiedAt: new Date(NOW.getTime() + 1_000),
      initialStatus: "PENDING",
    });
    expect(result.inserted).toBe(false);
    expect(result.record.externalEventId).toBe("evt_race_2");
    // The original receivedAt is preserved — the loser did not overwrite.
    expect(result.record.receivedAt).toEqual(NOW);
  });

  it("rethrows the original P2002 when the refetch finds nothing (row deleted under the race)", async () => {
    const { store, delegate } = build();
    const violation = uniqueViolation();
    delegate.failNextCreateWith = violation;
    delegate.findUniqueReturnsNull = true;
    await expect(
      store.recordReceived({
        event: event("evt_race_3"),
        receivedAt: NOW,
        signatureVerifiedAt: NOW,
        initialStatus: "PENDING",
      })
    ).rejects.toBe(violation);
  });

  it("rethrows non-P2002 errors untouched and never refetches", async () => {
    const { store, delegate } = build();
    const outage = new Error("connection reset");
    delegate.failNextCreateWith = outage;
    await expect(
      store.recordReceived({
        event: event("evt_err_1"),
        receivedAt: NOW,
        signatureVerifiedAt: NOW,
        initialStatus: "PENDING",
      })
    ).rejects.toBe(outage);
    expect(delegate.findUniqueCalls).toBe(0);
  });

  it("a P2002-coded error that is not a PrismaClientKnownRequestError is rethrown (no refetch)", async () => {
    const { store, delegate } = build();
    const impostor = Object.assign(new Error("unique-ish"), { code: "P2002" });
    delegate.failNextCreateWith = impostor;
    await expect(
      store.recordReceived({
        event: event("evt_err_2"),
        receivedAt: NOW,
        signatureVerifiedAt: NOW,
        initialStatus: "PENDING",
      })
    ).rejects.toBe(impostor);
    expect(delegate.findUniqueCalls).toBe(0);
  });
});

describe("PrismaEasyPostWebhookEventStore — claim/lease + terminal-state semantics", () => {
  it("each markProcessing claim bumps the attempts lease counter (audit trail of every claim)", async () => {
    const { store } = build();
    await seed(store, "evt_claim_1");
    const first = await store.markProcessing("evt_claim_1", NOW);
    const second = await store.markProcessing("evt_claim_1", new Date(NOW.getTime() + 5_000));
    // The store performs unconditional updates by documented contract —
    // single-claimer exclusivity comes from the worker's FOR UPDATE
    // SKIP LOCKED claim query upstream. What the store must guarantee
    // is that every claim is COUNTED, so a double-claim is visible.
    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(2);
    expect(second.processingStartedAt).toEqual(new Date(NOW.getTime() + 5_000));
  });

  it("a redelivered event cannot reset a SUCCEEDED row — dedupe returns the terminal row unchanged", async () => {
    const { store } = build();
    await seed(store, "evt_term_1");
    await store.markProcessing("evt_term_1", NOW);
    const done = await store.markSucceeded("evt_term_1", NOW);
    expect(done.status).toBe("SUCCEEDED");

    const redelivery = await store.recordReceived({
      event: event("evt_term_1"),
      receivedAt: new Date(NOW.getTime() + 60_000),
      signatureVerifiedAt: new Date(NOW.getTime() + 60_000),
      initialStatus: "PENDING",
    });
    expect(redelivery.inserted).toBe(false);
    expect(redelivery.record.status).toBe("SUCCEEDED");
    expect(redelivery.record.processedAt).toEqual(NOW);
    expect(redelivery.record.attempts).toBe(1);
  });

  it("a redelivered event cannot reset a FAILED row either — retry scheduling stays intact", async () => {
    const { store } = build();
    await seed(store, "evt_term_2");
    await store.markProcessing("evt_term_2", NOW);
    const nextAttemptAt = new Date(NOW.getTime() + 120_000);
    await store.markFailed({
      externalEventId: "evt_term_2",
      failedAt: NOW,
      errorMessage: "carrier 503",
      nextAttemptAt,
    });

    const redelivery = await store.recordReceived({
      event: event("evt_term_2"),
      receivedAt: new Date(NOW.getTime() + 30_000),
      signatureVerifiedAt: new Date(NOW.getTime() + 30_000),
      initialStatus: "PENDING",
    });
    expect(redelivery.inserted).toBe(false);
    expect(redelivery.record.status).toBe("FAILED");
    expect(redelivery.record.lastError).toBe("carrier 503");
    expect(redelivery.record.nextAttemptAt).toEqual(nextAttemptAt);
  });

  it("the retry lifecycle FAILED → PROCESSING → SUCCEEDED lands terminal with a clean error slate", async () => {
    const { store } = build();
    await seed(store, "evt_retry_1");
    await store.markProcessing("evt_retry_1", NOW);
    await store.markFailed({
      externalEventId: "evt_retry_1",
      failedAt: NOW,
      errorMessage: "transient",
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    const reclaimed = await store.markProcessing("evt_retry_1", new Date(NOW.getTime() + 31_000));
    expect(reclaimed.attempts).toBe(2);
    const done = await store.markSucceeded("evt_retry_1", new Date(NOW.getTime() + 32_000));
    expect(done.status).toBe("SUCCEEDED");
    expect(done.lastError).toBeNull();
    expect(done.nextAttemptAt).toBeNull();
  });
});
