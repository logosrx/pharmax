// PrismaFedExWebhookEventStore contract tests (coverage-audit
// 2026-08, backfill item 4).
//
// The FedEx store mirrors the EasyPost store one-for-one (see
// `prisma-event-store.test.ts` for the full rationale): the
// in-memory-twin contract is ported here against a fake Prisma
// delegate, plus the Prisma-only behavior — P2002 race-on-insert
// catch-and-refetch, error passthrough, claim counting, and
// terminal-row protection against carrier redelivery.
//
// FedEx publishes no per-delivery event id, so `externalEventId` is
// the caller's SHA-256 digest of the raw body — dedupe on redelivery
// of an identical body is byte-exact by construction.
//
// CLEAN ROOM / PHI: synthetic payloads only; the stored payload is
// the PHI-free replay subset the ingestion choke point projects.

import { Prisma, type FedExWebhookEvent } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import type { FedExWebhookStoredPayload } from "../carriers/fedex-webhook-payload.js";

import type { FedExRecordReceivedInput } from "./fedex-event-store.js";
import { PrismaFedExWebhookEventStore } from "./prisma-fedex-event-store.js";

const NOW = new Date("2026-05-24T18:00:00.000Z");

function receivedInput(
  externalEventId = "sha256-aaaa",
  overrides: Partial<FedExRecordReceivedInput> = {}
): FedExRecordReceivedInput {
  return {
    externalEventId,
    eventType: "TRACKING_UPDATE",
    trackingNumber: "794600000001",
    carrierStatus: "IT",
    payload: { events: [] } as unknown as FedExWebhookStoredPayload,
    receivedAt: NOW,
    signatureVerifiedAt: NOW,
    initialStatus: "PENDING",
    ...overrides,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`externalEventId`)",
    { code: "P2002", clientVersion: "0.0.0-test" }
  );
}

/** Fake of the narrow `FedExWebhookEventClient` delegate surface. */
class FakeFedExDelegate {
  public readonly rows = new Map<string, FedExWebhookEvent>();
  public createCalls = 0;
  public findUniqueCalls = 0;
  public failNextCreateWith: unknown = null;
  public findUniqueReturnsNull = false;
  private counter = 0;

  public readonly fedExWebhookEvent = {
    create: async (args: {
      data: Prisma.FedExWebhookEventCreateInput;
    }): Promise<FedExWebhookEvent> => {
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
        id: `db-fedex-${this.counter}`,
        externalEventId: data.externalEventId,
        eventType: data.eventType,
        trackingNumber: (data.trackingNumber ?? null) as string | null,
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
      } as unknown as FedExWebhookEvent;
      this.rows.set(data.externalEventId, row);
      return row;
    },

    findUnique: async (args: {
      where: Prisma.FedExWebhookEventWhereUniqueInput;
    }): Promise<FedExWebhookEvent | null> => {
      this.findUniqueCalls += 1;
      if (this.findUniqueReturnsNull) return null;
      return this.rows.get(args.where.externalEventId as string) ?? null;
    },

    update: async (args: {
      where: Prisma.FedExWebhookEventWhereUniqueInput;
      data: Prisma.FedExWebhookEventUpdateInput;
    }): Promise<FedExWebhookEvent> => {
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
      const updated = { ...existing, ...patch } as FedExWebhookEvent;
      this.rows.set(args.where.externalEventId as string, updated);
      return updated;
    },
  };
}

function build(): { store: PrismaFedExWebhookEventStore; delegate: FakeFedExDelegate } {
  const delegate = new FakeFedExDelegate();
  return { store: new PrismaFedExWebhookEventStore(delegate), delegate };
}

describe("PrismaFedExWebhookEventStore — ported in-memory-twin contract", () => {
  it("recordReceived returns inserted=true on first insert and inserted=false on duplicate", async () => {
    const { store } = build();
    const first = await store.recordReceived(receivedInput());
    const second = await store.recordReceived(receivedInput());
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it("recordReceived sets processedAt for IGNORED rows", async () => {
    const { store } = build();
    const result = await store.recordReceived(
      receivedInput("sha256-ignored", { initialStatus: "IGNORED" })
    );
    expect(result.inserted).toBe(true);
    expect(result.record.status).toBe("IGNORED");
    expect(result.record.processedAt).toEqual(NOW);
  });

  it("recordReceived persists the triage projection (trackingNumber, carrierStatus) and freezes the record", async () => {
    const { store } = build();
    const result = await store.recordReceived(receivedInput("sha256-proj"));
    expect(result.record.trackingNumber).toBe("794600000001");
    expect(result.record.carrierStatus).toBe("IT");
    expect(result.record.eventType).toBe("TRACKING_UPDATE");
    expect(Object.isFrozen(result.record)).toBe(true);
  });

  it("markProcessing bumps attempts and sets processingStartedAt", async () => {
    const { store } = build();
    await store.recordReceived(receivedInput("sha256-proc"));
    const processing = await store.markProcessing("sha256-proc", NOW);
    expect(processing.status).toBe("PROCESSING");
    expect(processing.attempts).toBe(1);
    expect(processing.processingStartedAt).toEqual(NOW);
  });

  it("markSucceeded clears lastError and nextAttemptAt", async () => {
    const { store } = build();
    await store.recordReceived(receivedInput("sha256-succ"));
    await store.markFailed({
      externalEventId: "sha256-succ",
      failedAt: NOW,
      errorMessage: "transient",
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    const result = await store.markSucceeded("sha256-succ", NOW);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.lastError).toBeNull();
    expect(result.nextAttemptAt).toBeNull();
  });

  it("markFailed records lastError and nextAttemptAt", async () => {
    const { store } = build();
    await store.recordReceived(receivedInput("sha256-fail"));
    const nextAttempt = new Date(NOW.getTime() + 60_000);
    const result = await store.markFailed({
      externalEventId: "sha256-fail",
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

describe("PrismaFedExWebhookEventStore — P2002 race-on-insert", () => {
  it("two concurrent recordReceived for the same digest: exactly one wins the insert, both get the same row", async () => {
    const { store, delegate } = build();
    const input = receivedInput("sha256-race");
    const [a, b] = await Promise.all([store.recordReceived(input), store.recordReceived(input)]);
    const insertedFlags = [a.inserted, b.inserted].sort();
    expect(insertedFlags).toEqual([false, true]);
    expect(a.record.id).toBe(b.record.id);
    expect(delegate.createCalls).toBe(2);
  });

  it("catches P2002 and refetches the winner's row instead of surfacing the violation", async () => {
    const { store, delegate } = build();
    await store.recordReceived(receivedInput("sha256-race2"));
    delegate.failNextCreateWith = uniqueViolation();
    const result = await store.recordReceived(
      receivedInput("sha256-race2", { receivedAt: new Date(NOW.getTime() + 1_000) })
    );
    expect(result.inserted).toBe(false);
    expect(result.record.receivedAt).toEqual(NOW);
  });

  it("rethrows the original P2002 when the refetch finds nothing (row deleted under the race)", async () => {
    const { store, delegate } = build();
    const violation = uniqueViolation();
    delegate.failNextCreateWith = violation;
    delegate.findUniqueReturnsNull = true;
    await expect(store.recordReceived(receivedInput("sha256-race3"))).rejects.toBe(violation);
  });

  it("rethrows non-P2002 errors untouched and never refetches", async () => {
    const { store, delegate } = build();
    const outage = new Error("connection reset");
    delegate.failNextCreateWith = outage;
    await expect(store.recordReceived(receivedInput("sha256-err"))).rejects.toBe(outage);
    expect(delegate.findUniqueCalls).toBe(0);
  });
});

describe("PrismaFedExWebhookEventStore — claim/lease + terminal-state semantics", () => {
  it("each markProcessing claim bumps the attempts lease counter", async () => {
    const { store } = build();
    await store.recordReceived(receivedInput("sha256-claim"));
    const first = await store.markProcessing("sha256-claim", NOW);
    const second = await store.markProcessing("sha256-claim", new Date(NOW.getTime() + 5_000));
    // Unconditional updates by documented contract; exclusivity is the
    // worker claim query's job (FOR UPDATE SKIP LOCKED). Every claim
    // must still be counted so contention is visible after the fact.
    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(2);
  });

  it("a redelivered body cannot reset a SUCCEEDED row — dedupe returns the terminal row unchanged", async () => {
    const { store } = build();
    await store.recordReceived(receivedInput("sha256-term"));
    await store.markProcessing("sha256-term", NOW);
    await store.markSucceeded("sha256-term", NOW);

    const redelivery = await store.recordReceived(
      receivedInput("sha256-term", { receivedAt: new Date(NOW.getTime() + 60_000) })
    );
    expect(redelivery.inserted).toBe(false);
    expect(redelivery.record.status).toBe("SUCCEEDED");
    expect(redelivery.record.processedAt).toEqual(NOW);
    expect(redelivery.record.attempts).toBe(1);
  });

  it("a redelivered body cannot reset a FAILED row — retry scheduling stays intact", async () => {
    const { store } = build();
    await store.recordReceived(receivedInput("sha256-term2"));
    await store.markProcessing("sha256-term2", NOW);
    const nextAttemptAt = new Date(NOW.getTime() + 120_000);
    await store.markFailed({
      externalEventId: "sha256-term2",
      failedAt: NOW,
      errorMessage: "carrier 503",
      nextAttemptAt,
    });

    const redelivery = await store.recordReceived(receivedInput("sha256-term2"));
    expect(redelivery.inserted).toBe(false);
    expect(redelivery.record.status).toBe("FAILED");
    expect(redelivery.record.nextAttemptAt).toEqual(nextAttemptAt);
  });
});
