// Unit tests for PrismaStripeWebhookEventStore. No real DB; the store is
// constructed with a structurally-typed PrismaClient stub so the
// idempotent-insert / mark-processing / mark-succeeded / mark-failed
// branches can be exercised without infrastructure.

import process from "node:process";

import type { billing } from "@pharmax/platform-core";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Prisma } from "../generated/client/client.js";
import type { StripeWebhookEvent } from "../generated/client/client.js";
import {
  PrismaStripeWebhookEventStore,
  type StripeWebhookEventClient,
} from "./prisma-stripe-webhook-event-store.js";

type StripeEvent = billing.RecordReceivedInput["event"];

beforeAll(() => {
  process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5432/test";
  process.env["DIRECT_URL"] ??= "postgresql://test:test@localhost:5432/test";
});

const FIXED_NOW = new Date("2026-05-14T10:00:00.000Z");

// `Stripe.Event` is a discriminated union of ~250 variants — `Partial<Event>`
// distributes the partial across each variant, which makes per-property
// overrides impractical. The fixture takes a loose record and casts at the
// boundary; assertions in each test verify the actual shape passed through.
function fakeStripeEvent(overrides: Record<string, unknown> = {}): StripeEvent {
  return {
    id: "evt_test_001",
    type: "invoice.paid",
    api_version: "2024-06-20",
    created: Math.floor(FIXED_NOW.getTime() / 1000),
    livemode: false,
    object: "event",
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: { id: "in_test_001" } },
    ...overrides,
  } as unknown as StripeEvent;
}

function fakeRow(overrides: Partial<StripeWebhookEvent> = {}): StripeWebhookEvent {
  return {
    id: "row-uuid-1",
    stripeEventId: "evt_test_001",
    eventType: "invoice.paid",
    apiVersion: "2024-06-20",
    livemode: false,
    payload: { id: "evt_test_001", type: "invoice.paid" } as unknown as Prisma.JsonValue,
    status: "PENDING",
    attempts: 0,
    lastError: null,
    receivedAt: FIXED_NOW,
    signatureVerifiedAt: FIXED_NOW,
    processingStartedAt: null,
    processedAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

function makeClient(): {
  client: StripeWebhookEventClient;
  create: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn();
  const findUnique = vi.fn();
  const update = vi.fn();
  return {
    client: {
      stripeWebhookEvent: {
        create,
        findUnique,
        update,
      },
    },
    create,
    findUnique,
    update,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PrismaStripeWebhookEventStore.recordReceived", () => {
  it("inserts a new row on the happy path", async () => {
    const { client, create } = makeClient();
    create.mockResolvedValueOnce(fakeRow());

    const store = new PrismaStripeWebhookEventStore(client);
    const result = await store.recordReceived({
      event: fakeStripeEvent(),
      receivedAt: FIXED_NOW,
      signatureVerifiedAt: FIXED_NOW,
      initialStatus: "PENDING",
    });

    expect(result.inserted).toBe(true);
    expect(result.record.stripeEventId).toBe("evt_test_001");
    expect(result.record.status).toBe("PENDING");
    expect(create).toHaveBeenCalledOnce();
    const callArgs = create.mock.calls[0]?.[0] as { data: Prisma.StripeWebhookEventCreateInput };
    expect(callArgs.data.stripeEventId).toBe("evt_test_001");
    expect(callArgs.data.processedAt).toBeNull();
  });

  it("sets processedAt when the initial status is IGNORED", async () => {
    const { client, create } = makeClient();
    create.mockResolvedValueOnce(fakeRow({ status: "IGNORED", processedAt: FIXED_NOW }));

    const store = new PrismaStripeWebhookEventStore(client);
    await store.recordReceived({
      event: fakeStripeEvent({ type: "customer.unknown" }),
      receivedAt: FIXED_NOW,
      signatureVerifiedAt: FIXED_NOW,
      initialStatus: "IGNORED",
    });

    const callArgs = create.mock.calls[0]?.[0] as { data: Prisma.StripeWebhookEventCreateInput };
    expect(callArgs.data.status).toBe("IGNORED");
    expect(callArgs.data.processedAt).toEqual(FIXED_NOW);
  });

  it("treats P2002 unique violation as idempotent no-op and refetches the existing row", async () => {
    const { client, create, findUnique } = makeClient();
    const existing = fakeRow({ status: "SUCCEEDED", attempts: 1 });
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.22.0",
      })
    );
    findUnique.mockResolvedValueOnce(existing);

    const store = new PrismaStripeWebhookEventStore(client);
    const result = await store.recordReceived({
      event: fakeStripeEvent(),
      receivedAt: FIXED_NOW,
      signatureVerifiedAt: FIXED_NOW,
      initialStatus: "PENDING",
    });

    expect(result.inserted).toBe(false);
    expect(result.record.status).toBe("SUCCEEDED");
    expect(findUnique).toHaveBeenCalledWith({ where: { stripeEventId: "evt_test_001" } });
  });

  it("rethrows non-P2002 errors", async () => {
    const { client, create } = makeClient();
    const boom = new Error("connection refused");
    create.mockRejectedValueOnce(boom);

    const store = new PrismaStripeWebhookEventStore(client);
    await expect(
      store.recordReceived({
        event: fakeStripeEvent(),
        receivedAt: FIXED_NOW,
        signatureVerifiedAt: FIXED_NOW,
        initialStatus: "PENDING",
      })
    ).rejects.toBe(boom);
  });

  it("rethrows the original conflict if the row vanishes between insert-fail and refetch", async () => {
    const { client, create, findUnique } = makeClient();
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.22.0",
    });
    create.mockRejectedValueOnce(conflict);
    findUnique.mockResolvedValueOnce(null);

    const store = new PrismaStripeWebhookEventStore(client);
    await expect(
      store.recordReceived({
        event: fakeStripeEvent(),
        receivedAt: FIXED_NOW,
        signatureVerifiedAt: FIXED_NOW,
        initialStatus: "PENDING",
      })
    ).rejects.toBe(conflict);
  });
});

describe("PrismaStripeWebhookEventStore.findByStripeEventId", () => {
  it("returns the mapped record on hit", async () => {
    const { client, findUnique } = makeClient();
    findUnique.mockResolvedValueOnce(fakeRow());

    const store = new PrismaStripeWebhookEventStore(client);
    const record = await store.findByStripeEventId("evt_test_001");

    expect(record).not.toBeNull();
    expect(record?.stripeEventId).toBe("evt_test_001");
  });

  it("returns null on miss", async () => {
    const { client, findUnique } = makeClient();
    findUnique.mockResolvedValueOnce(null);

    const store = new PrismaStripeWebhookEventStore(client);
    const record = await store.findByStripeEventId("evt_unknown");

    expect(record).toBeNull();
  });
});

describe("PrismaStripeWebhookEventStore.markProcessing", () => {
  it("transitions to PROCESSING and atomically increments attempts", async () => {
    const { client, update } = makeClient();
    update.mockResolvedValueOnce(
      fakeRow({ status: "PROCESSING", attempts: 1, processingStartedAt: FIXED_NOW })
    );

    const store = new PrismaStripeWebhookEventStore(client);
    const record = await store.markProcessing("evt_test_001", FIXED_NOW);

    expect(record.status).toBe("PROCESSING");
    expect(record.attempts).toBe(1);
    const callArgs = update.mock.calls[0]?.[0] as {
      where: Prisma.StripeWebhookEventWhereUniqueInput;
      data: Prisma.StripeWebhookEventUpdateInput;
    };
    expect(callArgs.where).toEqual({ stripeEventId: "evt_test_001" });
    expect(callArgs.data.attempts).toEqual({ increment: 1 });
    expect(callArgs.data.processingStartedAt).toBe(FIXED_NOW);
  });
});

describe("PrismaStripeWebhookEventStore.markSucceeded", () => {
  it("clears lastError and nextAttemptAt", async () => {
    const { client, update } = makeClient();
    update.mockResolvedValueOnce(
      fakeRow({
        status: "SUCCEEDED",
        attempts: 2,
        processedAt: FIXED_NOW,
        lastError: null,
        nextAttemptAt: null,
      })
    );

    const store = new PrismaStripeWebhookEventStore(client);
    const record = await store.markSucceeded("evt_test_001", FIXED_NOW);

    expect(record.status).toBe("SUCCEEDED");
    expect(record.lastError).toBeNull();
    expect(record.nextAttemptAt).toBeNull();
    const callArgs = update.mock.calls[0]?.[0] as {
      data: Prisma.StripeWebhookEventUpdateInput;
    };
    expect(callArgs.data).toMatchObject({
      status: "SUCCEEDED",
      processedAt: FIXED_NOW,
      lastError: null,
      nextAttemptAt: null,
    });
  });
});

describe("PrismaStripeWebhookEventStore.markFailed", () => {
  it("records the error message and the scheduled retry time", async () => {
    const { client, update } = makeClient();
    const failedAt = FIXED_NOW;
    const nextAttemptAt = new Date(FIXED_NOW.getTime() + 30_000);
    update.mockResolvedValueOnce(
      fakeRow({
        status: "FAILED",
        attempts: 1,
        processedAt: failedAt,
        lastError: "Error: dispatcher boom",
        nextAttemptAt,
      })
    );

    const store = new PrismaStripeWebhookEventStore(client);
    const record = await store.markFailed({
      stripeEventId: "evt_test_001",
      failedAt,
      errorMessage: "Error: dispatcher boom",
      nextAttemptAt,
    });

    expect(record.status).toBe("FAILED");
    expect(record.lastError).toBe("Error: dispatcher boom");
    expect(record.nextAttemptAt).toEqual(nextAttemptAt);
    const callArgs = update.mock.calls[0]?.[0] as {
      data: Prisma.StripeWebhookEventUpdateInput;
    };
    expect(callArgs.data).toMatchObject({
      status: "FAILED",
      lastError: "Error: dispatcher boom",
      nextAttemptAt,
    });
  });

  it("accepts a null nextAttemptAt when retries are exhausted", async () => {
    const { client, update } = makeClient();
    update.mockResolvedValueOnce(
      fakeRow({ status: "FAILED", attempts: 8, processedAt: FIXED_NOW, nextAttemptAt: null })
    );

    const store = new PrismaStripeWebhookEventStore(client);
    const record = await store.markFailed({
      stripeEventId: "evt_test_001",
      failedAt: FIXED_NOW,
      errorMessage: "Error: dead",
      nextAttemptAt: null,
    });

    expect(record.nextAttemptAt).toBeNull();
  });
});
