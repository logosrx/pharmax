// Tests for the outbound webhook delivery drain (ADR-0032).
//
// Harness: an in-memory `webhook_delivery` store that implements the
// SAME claim/lease/fence semantics as the raw SQL in
// `claim-webhook-deliveries.ts` (bump `attempts` as the fence token,
// push `nextAttemptAt` to now + leaseMs), plus a captured fake fetch
// injected through the REAL `attemptWebhookDelivery` transport — so
// the signature the partner would verify is produced by the real
// signing path, not a stub.
//
// Synthetic data only: ids/payloads are fabricated, the signing
// secret is a test constant, and no payload carries PHI.

import { describe, expect, it, vi } from "vitest";

import {
  attemptWebhookDelivery,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  type AttemptWebhookDeliveryInput,
  type AttemptWebhookDeliveryResult,
} from "@pharmax/partner-api";
import { logger as loggerNs } from "@pharmax/platform-core";

import {
  createWebhookDeliveryDrainer,
  type ClaimedWebhookDeliveryRow,
  type WebhookDeliveryDrainerDeps,
} from "./webhook-delivery-drainer.js";

const noopLogger = loggerNs.noopLogger;

const ORG_ID = "11111111-1111-1111-1111-000000000001";
const SUBSCRIPTION_ID = "22222222-2222-2222-2222-000000000001";
const SECRET = "pxw_test-secret-for-drainer-unit-tests-00000000";
const SUBSCRIPTION_URL = "https://partner.example/hooks";
const T0 = new Date("2026-08-01T12:00:00.000Z");

/** A globally routable address the outbound tables accept. */
const PUBLIC_V4 = { address: "8.8.8.8", family: 4 } as const;
const publicResolver = async (): Promise<readonly (typeof PUBLIC_V4)[]> => [PUBLIC_V4];

interface StoredDeliveryRow {
  id: string;
  organizationId: string;
  subscriptionId: string;
  outboxEventId: string;
  eventType: string;
  payload: unknown;
  status: "PENDING" | "FAILED" | "SENT" | "DEAD";
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  responseStatus: number | null;
  deliveredAt: Date | null;
  traceparent: string | null;
  createdAt: Date;
}

interface StoredSubscriptionRow {
  url: string;
  secretEnc: unknown;
  status: "ACTIVE" | "DISABLED";
}

/**
 * In-memory twin of the `webhook_delivery` work queue.
 *
 * `$queryRaw` reproduces the claim UPDATE: eligible rows are
 * PENDING/FAILED whose `nextAttemptAt` has passed; claiming bumps
 * `attempts` (the fence) and leases the row for `leaseMs`. The claim
 * body is synchronous, so two drainers racing over one store observe
 * the same atomicity the SQL's `FOR UPDATE SKIP LOCKED` provides.
 *
 * `webhookDelivery.updateMany` reproduces the fenced completion:
 * the write applies only when `attempts` still equals the claim-time
 * token, which is exactly the lease-loss detection the drainer
 * relies on.
 */
class InMemoryWebhookStore {
  public now = new Date(T0);
  public readonly deliveries = new Map<string, StoredDeliveryRow>();
  public readonly subscriptions = new Map<string, StoredSubscriptionRow>();

  private readonly tx = {
    $executeRaw: async (): Promise<number> => 0,
    webhookSubscription: {
      findUnique: async (args: { where: { id: string } }): Promise<StoredSubscriptionRow | null> =>
        this.subscriptions.get(args.where.id) ?? null,
    },
    webhookDelivery: {
      updateMany: async (args: {
        where: { id: string; attempts: number };
        data: Partial<StoredDeliveryRow>;
      }): Promise<{ count: number }> => {
        const row = this.deliveries.get(args.where.id);
        if (row === undefined || row.attempts !== args.where.attempts) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };

  public readonly client = {
    // Values arrive in template order: leaseMs first, then batchSize
    // (see the SQL in claim-webhook-deliveries.ts).
    $queryRaw: async (
      _strings: TemplateStringsArray,
      ...values: ReadonlyArray<unknown>
    ): Promise<StoredDeliveryRow[]> => {
      const leaseMs = Number(values[0]);
      const batchSize = Number(values[1]);
      const eligible = [...this.deliveries.values()]
        .filter(
          (row) =>
            (row.status === "PENDING" || row.status === "FAILED") &&
            (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= this.now.getTime())
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, batchSize);
      for (const row of eligible) {
        row.attempts += 1;
        row.nextAttemptAt = new Date(this.now.getTime() + leaseMs);
      }
      return eligible.map((row) => ({ ...row }));
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(this.tx),
  };

  seedSubscription(overrides: Partial<StoredSubscriptionRow> = {}): void {
    this.subscriptions.set(SUBSCRIPTION_ID, {
      url: SUBSCRIPTION_URL,
      secretEnc: { v: 1, blob: "opaque-encrypted-secret-envelope" },
      status: "ACTIVE",
      ...overrides,
    });
  }

  seedDelivery(overrides: Partial<StoredDeliveryRow> = {}): StoredDeliveryRow {
    const row: StoredDeliveryRow = {
      id: "delivery-1",
      organizationId: ORG_ID,
      subscriptionId: SUBSCRIPTION_ID,
      outboxEventId: "outbox-1",
      eventType: "order.shipped.v1",
      payload: { orderId: "33333333-3333-3333-3333-000000000001", carrier: "UPS" },
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      responseStatus: null,
      deliveredAt: null,
      traceparent: null,
      createdAt: new Date(T0.getTime() - 60_000),
      ...overrides,
    };
    this.deliveries.set(row.id, row);
    return row;
  }
}

interface CapturedFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type FetchBehavior = (call: CapturedFetchCall) => Promise<{ status: number }>;

function captureFetch(behavior: FetchBehavior = async () => ({ status: 200 })): {
  fetchImpl: typeof fetch;
  calls: CapturedFetchCall[];
} {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call: CapturedFetchCall = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body),
    };
    calls.push(call);
    const { status } = await behavior(call);
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface BuildDrainerOptions {
  readonly store: InMemoryWebhookStore;
  readonly fetchImpl: typeof fetch;
  readonly depsOverrides?: Partial<WebhookDeliveryDrainerDeps>;
  readonly leaseMs?: number;
}

function buildDrainer(options: BuildDrainerOptions): {
  tick: () => Promise<{
    claimed: number;
    sent: number;
    failed: number;
    dead: number;
    leaseLost: number;
  }>;
  decryptCalls: Array<{ envelope: unknown; organizationId: string; subscriptionId: string }>;
} {
  const decryptCalls: Array<{
    envelope: unknown;
    organizationId: string;
    subscriptionId: string;
  }> = [];
  const drainer = createWebhookDeliveryDrainer(
    {
      client: options.store.client as never,
      logger: noopLogger,
      clock: () => options.store.now,
      decryptSecret: async (input) => {
        decryptCalls.push(input);
        return SECRET;
      },
      // Route through the REAL transport so the signature and the
      // envelope on the wire are produced by production code; only
      // the socket layer (fetch + DNS) is faked.
      attempt: (input: AttemptWebhookDeliveryInput): Promise<AttemptWebhookDeliveryResult> =>
        attemptWebhookDelivery({
          ...input,
          fetchImpl: options.fetchImpl,
          resolveAddresses: publicResolver,
          nowMs: options.store.now.getTime(),
        }),
      ...options.depsOverrides,
    },
    { batchSize: 10, leaseMs: options.leaseMs ?? 60_000 }
  );
  return { tick: drainer.tick, decryptCalls };
}

describe("webhook-delivery-drainer — idle", () => {
  it("returns zeros and makes no HTTP attempt when nothing is claimable", async () => {
    const store = new InMemoryWebhookStore();
    const { fetchImpl, calls } = captureFetch();
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 0, sent: 0, failed: 0, dead: 0, leaseLost: 0 });
    expect(calls).toHaveLength(0);
  });

  it("skips rows whose lease/backoff has not passed", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    store.seedDelivery({ nextAttemptAt: new Date(store.now.getTime() + 30_000) });
    const { fetchImpl, calls } = captureFetch();
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result.claimed).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("webhook-delivery-drainer — happy path", () => {
  it("claims a PENDING delivery, POSTs a signed envelope, and marks it SENT", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery();
    const { fetchImpl, calls } = captureFetch();
    const { tick, decryptCalls } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0, leaseLost: 0 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.url).toBe(SUBSCRIPTION_URL);

    // The envelope carries the delivery id (partner dedupe key), the
    // event type, the outbox createdAt, and the payload verbatim.
    const envelope = JSON.parse(call.body) as Record<string, unknown>;
    expect(envelope["id"]).toBe(seeded.id);
    expect(envelope["type"]).toBe("order.shipped.v1");
    expect(envelope["occurredAt"]).toBe(seeded.createdAt.toISOString());
    expect(envelope["data"]).toEqual(seeded.payload);

    // Signature header verifies against the KNOWN secret and the
    // EXACT body that went over the wire — the contract partners
    // code their verifiers to.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: call.headers[WEBHOOK_SIGNATURE_HEADER] ?? "",
        body: call.body,
        nowSeconds: Math.floor(store.now.getTime() / 1000),
      })
    ).toBe(true);

    // The secret was decrypted under the subscription's own binding
    // tuple (org + subscription), from the stored envelope.
    expect(decryptCalls).toEqual([
      {
        envelope: { v: 1, blob: "opaque-encrypted-secret-envelope" },
        organizationId: ORG_ID,
        subscriptionId: SUBSCRIPTION_ID,
      },
    ]);

    const row = store.deliveries.get(seeded.id);
    expect(row).toMatchObject({
      status: "SENT",
      attempts: 1,
      responseStatus: 200,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(row?.deliveredAt).toEqual(store.now);
  });

  it("signs and sends the payload immutably — what was signed is what was sent", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const payload = {
      orderId: "33333333-3333-3333-3333-000000000002",
      lines: [{ sku: "TEST-SKU-1", quantity: 2 }],
      nested: { flag: true },
    };
    const snapshot = structuredClone(payload);
    const seeded = store.seedDelivery({ payload });
    const { fetchImpl, calls } = captureFetch();
    const { tick } = buildDrainer({ store, fetchImpl });

    await tick();

    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    // The signature covers the exact body string that hit the wire...
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: call.headers[WEBHOOK_SIGNATURE_HEADER] ?? "",
        body: call.body,
        nowSeconds: Math.floor(store.now.getTime() / 1000),
      })
    ).toBe(true);
    // ...that body embeds the payload verbatim...
    expect((JSON.parse(call.body) as { data: unknown }).data).toEqual(snapshot);
    // ...and the stored row's payload was not mutated by delivery.
    expect(store.deliveries.get(seeded.id)?.payload).toEqual(snapshot);
  });
});

describe("webhook-delivery-drainer — retry/backoff schedule", () => {
  // The documented schedule: 30s, 1m, 2m, 4m, 8m, 16m, 32m, 64m —
  // 30 * 2^(attempt-1) seconds where `attempt` is the CLAIM-TIME
  // (post-bump) attempts value. Assert the exact timestamps, not
  // just "a retry happened".
  it.each([
    { priorAttempts: 0, expectedDelaySeconds: 30 },
    { priorAttempts: 1, expectedDelaySeconds: 60 },
    { priorAttempts: 2, expectedDelaySeconds: 120 },
    { priorAttempts: 3, expectedDelaySeconds: 240 },
    { priorAttempts: 4, expectedDelaySeconds: 480 },
    { priorAttempts: 5, expectedDelaySeconds: 960 },
    { priorAttempts: 6, expectedDelaySeconds: 1920 },
  ])(
    "5xx with $priorAttempts prior attempts → FAILED, retry in $expectedDelaySeconds s",
    async ({ priorAttempts, expectedDelaySeconds }) => {
      const store = new InMemoryWebhookStore();
      store.seedSubscription();
      const seeded = store.seedDelivery({
        status: priorAttempts === 0 ? "PENDING" : "FAILED",
        attempts: priorAttempts,
      });
      const { fetchImpl } = captureFetch(async () => ({ status: 503 }));
      const { tick } = buildDrainer({ store, fetchImpl });

      const result = await tick();

      expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0, leaseLost: 0 });
      const row = store.deliveries.get(seeded.id);
      expect(row).toMatchObject({
        status: "FAILED",
        attempts: priorAttempts + 1,
        responseStatus: 503,
        lastError: "Endpoint responded 503",
        deliveredAt: null,
      });
      expect(row?.nextAttemptAt).toEqual(
        new Date(store.now.getTime() + expectedDelaySeconds * 1000)
      );
    }
  );

  it("schedules a retry after a network error (transport threw, no HTTP status)", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery();
    const { fetchImpl } = captureFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0, leaseLost: 0 });
    expect(store.deliveries.get(seeded.id)).toMatchObject({
      status: "FAILED",
      responseStatus: null,
      lastError: "TypeError: fetch failed",
      nextAttemptAt: new Date(store.now.getTime() + 30_000),
    });
  });

  it("schedules a retry when secret decryption fails, without opening a socket", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery();
    const { fetchImpl, calls } = captureFetch();
    const { tick } = buildDrainer({
      store,
      fetchImpl,
      depsOverrides: {
        decryptSecret: async () => {
          throw new Error("kms unavailable");
        },
      },
    });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0, leaseLost: 0 });
    expect(calls).toHaveLength(0);
    expect(store.deliveries.get(seeded.id)).toMatchObject({
      status: "FAILED",
      lastError: "Error: kms unavailable",
      responseStatus: null,
    });
  });
});

describe("webhook-delivery-drainer — dead-letter", () => {
  it("DEADs a delivery whose claim reached maxAttempts (8th attempt still failing)", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery({ status: "FAILED", attempts: 7 });
    const { fetchImpl } = captureFetch(async () => ({ status: 503 }));
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, dead: 1, leaseLost: 0 });
    expect(store.deliveries.get(seeded.id)).toMatchObject({
      status: "DEAD",
      attempts: 8,
      responseStatus: 503,
      lastError: "Endpoint responded 503",
      nextAttemptAt: null,
      deliveredAt: null,
    });
  });

  it("DEADs immediately on a DISABLED subscription — no HTTP attempt, even on attempt 1", async () => {
    // A tenant disabling an endpoint (e.g. after a compromise) must
    // stop egress, not merely stop new fan-out.
    const store = new InMemoryWebhookStore();
    store.seedSubscription({ status: "DISABLED" });
    const seeded = store.seedDelivery();
    const { fetchImpl, calls } = captureFetch();
    const { tick, decryptCalls } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, dead: 1, leaseLost: 0 });
    expect(calls).toHaveLength(0);
    expect(decryptCalls).toHaveLength(0);
    expect(store.deliveries.get(seeded.id)).toMatchObject({
      status: "DEAD",
      attempts: 1,
      responseStatus: null,
      lastError: "Subscription disabled",
      nextAttemptAt: null,
    });
  });

  it("DEADs immediately when the subscription row no longer exists", async () => {
    const store = new InMemoryWebhookStore();
    // No subscription seeded — simulates a cascade delete.
    const seeded = store.seedDelivery();
    const { fetchImpl, calls } = captureFetch();
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, dead: 1, leaseLost: 0 });
    expect(calls).toHaveLength(0);
    expect(store.deliveries.get(seeded.id)).toMatchObject({
      status: "DEAD",
      lastError: "Subscription no longer exists",
    });
  });
});

describe("webhook-delivery-drainer — claim contention and lease loss", () => {
  it("two concurrent claimers over one row: exactly one claims and delivers", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery();
    const { fetchImpl, calls } = captureFetch();
    const a = buildDrainer({ store, fetchImpl });
    const b = buildDrainer({ store, fetchImpl });

    const [resultA, resultB] = await Promise.all([a.tick(), b.tick()]);

    // The claim is atomic: one drainer got the row, the other got
    // nothing. Exactly one HTTP delivery, exactly one SENT mark.
    expect(resultA.claimed + resultB.claimed).toBe(1);
    expect(resultA.sent + resultB.sent).toBe(1);
    expect(resultA.leaseLost + resultB.leaseLost).toBe(0);
    expect(calls).toHaveLength(1);
    expect(store.deliveries.get(seeded.id)).toMatchObject({ status: "SENT", attempts: 1 });
  });

  it("a claimer that outlives its lease loses the fenced completion — the re-claimer's delivery wins", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery();

    // Drainer A's HTTP attempt hangs past the lease.
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const slowFetch = captureFetch(async () => {
      await gateA;
      return { status: 200 };
    });
    const a = buildDrainer({ store, fetchImpl: slowFetch.fetchImpl, leaseMs: 60_000 });

    const aTick = a.tick();
    await vi.waitFor(() => {
      expect(slowFetch.calls).toHaveLength(1);
    });

    // Lease expires; drainer B re-claims (attempts 1 → 2) and
    // delivers promptly.
    store.now = new Date(store.now.getTime() + 61_000);
    const fastFetch = captureFetch();
    const b = buildDrainer({ store, fetchImpl: fastFetch.fetchImpl, leaseMs: 60_000 });
    const resultB = await b.tick();
    expect(resultB).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0, leaseLost: 0 });
    const deliveredAtByB = store.deliveries.get(seeded.id)?.deliveredAt;

    // A's response finally lands, but its completion is fenced on
    // the stale attempts token and must match zero rows.
    releaseA?.();
    const resultA = await aTick;
    expect(resultA).toEqual({ claimed: 1, sent: 0, failed: 0, dead: 0, leaseLost: 1 });

    // Exactly one delivery was recorded; A did not overwrite B's.
    expect(store.deliveries.get(seeded.id)).toMatchObject({ status: "SENT", attempts: 2 });
    expect(store.deliveries.get(seeded.id)?.deliveredAt).toEqual(deliveredAtByB);
  });

  it("counts leaseLost on the FAILURE path too when another worker re-claimed mid-attempt", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const seeded = store.seedDelivery();
    // Simulate a re-claim during the HTTP attempt: the fence token
    // moves, then the attempt fails with a 503.
    const { fetchImpl } = captureFetch(async () => {
      const row = store.deliveries.get(seeded.id);
      if (row !== undefined) {
        row.attempts += 1;
      }
      return { status: 503 };
    });
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, dead: 0, leaseLost: 1 });
    // This worker's FAILED write must not have applied.
    expect(store.deliveries.get(seeded.id)?.status).toBe("PENDING");
  });
});

describe("webhook-delivery-drainer — mixed batch", () => {
  it("tallies sent / failed / dead independently across one tick", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    const disabledSubId = "22222222-2222-2222-2222-000000000002";
    store.subscriptions.set(disabledSubId, {
      url: SUBSCRIPTION_URL,
      secretEnc: { v: 1, blob: "other-envelope" },
      status: "DISABLED",
    });

    const okRow = store.seedDelivery({
      id: "delivery-ok",
      createdAt: new Date(T0.getTime() - 3_000),
    });
    const failRow = store.seedDelivery({
      id: "delivery-fail",
      createdAt: new Date(T0.getTime() - 2_000),
    });
    const deadRow = store.seedDelivery({
      id: "delivery-dead",
      subscriptionId: disabledSubId,
      createdAt: new Date(T0.getTime() - 1_000),
    });

    // Rows are processed in createdAt order: ok, fail, dead.
    let httpCall = 0;
    const { fetchImpl } = captureFetch(async () => {
      httpCall += 1;
      return { status: httpCall === 1 ? 200 : 503 };
    });
    const { tick } = buildDrainer({ store, fetchImpl });

    const result = await tick();

    expect(result).toEqual({ claimed: 3, sent: 1, failed: 1, dead: 1, leaseLost: 0 });
    expect(store.deliveries.get(okRow.id)?.status).toBe("SENT");
    expect(store.deliveries.get(failRow.id)?.status).toBe("FAILED");
    expect(store.deliveries.get(deadRow.id)?.status).toBe("DEAD");
  });
});

// Type-level guard: the store's client shape stays assignable to the
// drainer's claim surface (compilation is the assertion).
describe("in-memory store fidelity", () => {
  it("returns claim rows shaped like ClaimedWebhookDeliveryRow", async () => {
    const store = new InMemoryWebhookStore();
    store.seedSubscription();
    store.seedDelivery();
    const rows = await store.client.$queryRaw(
      Object.assign([""], { raw: [""] }) as TemplateStringsArray,
      60_000,
      10
    );
    const first = rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const shaped: Omit<ClaimedWebhookDeliveryRow, "status" | "payload"> & {
      status: string;
      payload: unknown;
    } = first;
    expect(shaped.attempts).toBe(1);
    expect(first.nextAttemptAt).toEqual(new Date(store.now.getTime() + 60_000));
  });
});
