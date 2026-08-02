// Worker-dispatch tests for the FedEx AIV webhook pipeline.
//
// Failure branches (unknown target, resolver throw, terminal after
// max attempts) run against a fake resolver without the command bus.
// The happy path runs THROUGH the real command bus against a Prisma
// fake — the point being to prove that a webhook delivery produces
// per-scan `shipment_tracking_event` rows with the SAME
// externalEventId format the polling channel derives, which is the
// cross-channel dedupe invariant.

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock as clockNs, logger as loggerNs } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FedExWebhookStoredPayload } from "../carriers/fedex-webhook-payload.js";

import { FedExWebhookEventNotFoundError } from "./errors.js";
import { InMemoryFedExWebhookEventStore } from "./in-memory-fedex-event-store.js";
import {
  executeFedExWebhookEventDispatch,
  processFedExWebhookEvent,
  type FedExWebhookTargetResolver,
} from "./process-fedex-webhook-event.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const TRACKING_NUMBER = "794665654567";
const NOW = new Date("2026-07-21T16:00:02.000Z");

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_RECORD_TRACKING_EVENT]),
  },
];

function storedPayload(): FedExWebhookStoredPayload {
  return {
    entries: [
      {
        trackingNumber: TRACKING_NUMBER,
        trackResult: {
          latestStatusDetail: { code: "IT", statusByLocale: "In transit" },
          dateAndTimes: [{ type: "ESTIMATED_DELIVERY", dateTime: "2026-07-23T20:00:00-04:00" }],
          // Newest-first, as FedEx delivers them.
          scanEvents: [
            {
              date: "2026-07-21T08:00:00-04:00",
              eventType: "AR",
              eventDescription: "Arrived at FedEx hub",
              derivedStatusCode: "IT",
              scanLocation: { city: "MEMPHIS", stateOrProvinceCode: "TN", countryCode: "US" },
            },
            {
              date: "2026-07-20T20:00:00-04:00",
              eventType: "PU",
              eventDescription: "Picked up",
              derivedStatusCode: "PU",
              scanLocation: { city: "AUSTIN", stateOrProvinceCode: "TX", countryCode: "US" },
            },
          ],
        },
      },
    ],
  };
}

async function seedPendingRow(
  eventStore: InMemoryFedExWebhookEventStore,
  externalEventId: string,
  payload: FedExWebhookStoredPayload = storedPayload()
) {
  const { record } = await eventStore.recordReceived({
    externalEventId,
    eventType: "fedex.aiv.track",
    trackingNumber: TRACKING_NUMBER,
    carrierStatus: "IT",
    payload,
    receivedAt: NOW,
    signatureVerifiedAt: NOW,
    initialStatus: "PENDING",
  });
  return record;
}

function unknownTargetResolver(): FedExWebhookTargetResolver {
  return { resolve: async () => null };
}

function knownTargetResolver(): FedExWebhookTargetResolver {
  return {
    resolve: async () => ({
      organizationId: ORG_ID,
      shipmentId: SHIPMENT_ID,
      actorUserId: USER_ID,
    }),
  };
}

function buildPrismaFake() {
  const shipmentTrackingEventCreate = vi.fn(async () => ({ id: "ste-1" }));
  const shipmentUpdate = vi.fn(async () => ({ id: SHIPMENT_ID }));

  const tx = {
    shipment: {
      findFirst: vi.fn(async () => ({
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: "CONFIRMED",
        lastTrackingEventAt: null,
        lastTrackingEventKind: null,
        pickedUpAt: null,
        deliveredAt: null,
      })),
      update: shipmentUpdate,
    },
    shipmentTrackingEvent: { create: shipmentTrackingEventCreate },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
  };

  return { client, shipmentTrackingEventCreate, shipmentUpdate };
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("processFedExWebhookEvent — short-circuit branches", () => {
  let eventStore: InMemoryFedExWebhookEventStore;

  beforeEach(() => {
    eventStore = new InMemoryFedExWebhookEventStore();
  });

  it("throws FedExWebhookEventNotFoundError when the row is missing", async () => {
    await expect(
      processFedExWebhookEvent("fedex-wh:missing", {
        eventStore,
        targetResolver: unknownTargetResolver(),
        logger: loggerNs.noopLogger,
        clock: () => NOW,
      })
    ).rejects.toBeInstanceOf(FedExWebhookEventNotFoundError);
  });

  it("returns succeeded without re-running for an already-SUCCEEDED row", async () => {
    await seedPendingRow(eventStore, "fedex-wh:done");
    await eventStore.markSucceeded("fedex-wh:done", NOW);

    const result = await processFedExWebhookEvent("fedex-wh:done", {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    });

    expect(result.status).toBe("succeeded");
  });

  it("marks FAILED (retryable) when the resolver returns null — early deliveries must not be dropped", async () => {
    const record = await seedPendingRow(eventStore, "fedex-wh:unknown");
    const claimed = await eventStore.markProcessing(record.externalEventId, NOW);

    const result = await executeFedExWebhookEventDispatch(claimed, {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    });

    expect(result.status).toBe("failed");
    expect(result.record.status).toBe("FAILED");
    expect(result.record.lastError).toContain("No shipment matches");
    if (result.status === "failed") {
      expect(result.retryScheduledFor).toBeInstanceOf(Date);
    }
  });

  it("goes FAILED-terminal (no retry) once attempts reach maxAttempts", async () => {
    const record = await seedPendingRow(eventStore, "fedex-wh:terminal");
    let claimed = await eventStore.markProcessing(record.externalEventId, NOW);
    claimed = { ...claimed, attempts: 8 };

    const result = await executeFedExWebhookEventDispatch(claimed, {
      eventStore,
      targetResolver: unknownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
      maxAttempts: 8,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.retryScheduledFor).toBeNull();
    }
  });
});

describe("executeFedExWebhookEventDispatch — full-bus happy path", () => {
  it("dispatches one RecordShipmentTrackingEvent per scan, oldest-first, with poller-identical externalEventIds", async () => {
    const eventStore = new InMemoryFedExWebhookEventStore();
    const record = await seedPendingRow(eventStore, "fedex-wh:happy");
    const claimed = await eventStore.markProcessing(record.externalEventId, NOW);

    const fake = buildPrismaFake();
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clockNs.createFrozenClock(NOW),
      logger: loggerNs.noopLogger,
    });

    const result = await executeFedExWebhookEventDispatch(claimed, {
      eventStore,
      targetResolver: knownTargetResolver(),
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    });

    expect(result.status).toBe("succeeded");
    expect(result.record.status).toBe("SUCCEEDED");

    expect(fake.shipmentTrackingEventCreate).toHaveBeenCalledTimes(2);
    const calls = fake.shipmentTrackingEventCreate.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    const first = calls[0]![0].data;
    const second = calls[1]![0].data;

    // Oldest-first, scan-format ids — byte-identical to what the
    // polling channel derives for the same physical scans.
    expect(String(first["externalEventId"])).toContain(`fedex:${TRACKING_NUMBER}:scan:PU:`);
    expect(first["source"]).toBe("FEDEX");
    expect(first["scanCity"]).toBe("AUSTIN");
    expect(String(second["externalEventId"])).toContain(`fedex:${TRACKING_NUMBER}:scan:AR:`);
    expect(second["kind"]).toBe("IN_TRANSIT");
    expect(second["scanCity"]).toBe("MEMPHIS");

    // The delivery estimate refreshes the shipment via the newest event.
    const updateCalls = fake.shipmentUpdate.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    const estimatedUpdates = updateCalls.filter(
      (c) => c[0].data["estimatedDeliveryAt"] !== undefined
    );
    expect(estimatedUpdates).toHaveLength(1);
    expect(estimatedUpdates[0]![0].data["estimatedDeliveryAt"]).toEqual(
      new Date("2026-07-23T20:00:00-04:00")
    );
  });
});
