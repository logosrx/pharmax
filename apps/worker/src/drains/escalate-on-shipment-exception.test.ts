// Unit tests for the shipment-exception escalation outbox handler.
//
// We drive the real handler against a real (in-process) command
// bus + RBAC + tenancy, and stub the Prisma surface the handler
// touches. The handler's `withSystemContext` actor lookup and
// `withTenancyContext` command dispatch run end-to-end.

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { clock, logger as loggerNs } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { RoleScope } from "@pharmax/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEscalateOnShipmentExceptionHandler } from "./escalate-on-shipment-exception.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SHIPMENT_ID = "00000000-0000-4000-8000-000000000ee0";
const TRACKING_EVENT_ID = "00000000-0000-4000-8000-000000000ee1";
const EMERGENCY_BUCKET_ID = "00000000-0000-4000-8000-000000000ee2";
const SHIPPING_BUCKET_ID = "00000000-0000-4000-8000-000000000ee3";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_ESCALATE_TO_EMERGENCY]),
  },
];

interface BuildClientInput {
  organization: { slug: string } | null;
  actor: { id: string } | null;
  emergencyBucket: { id: string; siteId: string } | null;
  lockedOrder: { currentBucketId: string; version: number };
}

function buildPrismaFake(input: BuildClientInput) {
  const orderUpdate = vi.fn(async () => ({ id: ORDER_ID }));
  const orderUpdateMany = vi.fn(async () => ({ count: 1 }));
  const bucketFindUnique = vi.fn(async () => input.emergencyBucket);

  const tx = {
    bucket: { findUnique: bucketFindUnique },
    order: { update: orderUpdate, updateMany: orderUpdateMany },
    orderEvent: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "oe" })),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
    auditLog: { create: vi.fn(async () => ({ id: "al" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
    $queryRaw: vi.fn(async (template: TemplateStringsArray) => {
      const joined = template.join("?");
      if (/FROM\s+"?order"?/i.test(joined) && /FOR\s+UPDATE/i.test(joined)) {
        return [
          {
            id: ORDER_ID,
            organizationId: ORG_ID,
            clinicId: "00000000-0000-4000-8000-000000000002",
            siteId: SITE_ID,
            currentBucketId: input.lockedOrder.currentBucketId,
            currentStatus: "SHIPPED",
            version: input.lockedOrder.version,
            workflowPolicyId: "00000000-0000-4000-8000-000000000008",
            workflowPolicyVersion: 1,
          },
        ];
      }
      return [];
    }),
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    organization: { findUnique: vi.fn(async () => input.organization) },
    user: { findFirst: vi.fn(async () => input.actor) },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, tx, orderUpdate, orderUpdateMany };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T15:30:00.000Z")),
    logger: loggerNs.noopLogger,
  });
}

function buildRow(payload: Record<string, unknown>): ClaimedOutboxEventRow {
  return {
    id: "outbox-1",
    organizationId: ORG_ID,
    eventType: "shipment.tracking.recorded.v1",
    aggregateType: "Shipment",
    aggregateId: SHIPMENT_ID,
    payload,
    attempts: 1,
    occurredAt: new Date("2026-05-25T15:00:00.000Z"),
  } as unknown as ClaimedOutboxEventRow;
}

const HANDLER_CTX = { logger: loggerNs.noopLogger, receivedAt: new Date() };

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("createEscalateOnShipmentExceptionHandler — escalation kinds", () => {
  it.each([
    ["EXCEPTION", "DE"],
    ["FAILED_DELIVERY", "FD"],
    ["RETURN_TO_SENDER", "RS"],
  ])("escalates when kind is %s", async (kind, carrierStatus) => {
    const fake = buildPrismaFake({
      organization: { slug: "acme" },
      actor: { id: USER_ID },
      emergencyBucket: { id: EMERGENCY_BUCKET_ID, siteId: SITE_ID },
      lockedOrder: { currentBucketId: SHIPPING_BUCKET_ID, version: 5 },
    });
    configureBus(fake.client);

    const handler = createEscalateOnShipmentExceptionHandler({ client: fake.client as never });
    const row = buildRow({
      organizationId: ORG_ID,
      shipmentId: SHIPMENT_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      source: "EASYPOST",
      trackingEventId: TRACKING_EVENT_ID,
      externalEventId: `evt_${kind}`,
      kind,
      carrierStatus,
      occurredAt: "2026-05-25T15:00:00.000Z",
      cachedStatusAdvanced: true,
    });

    await handler(row, HANDLER_CTX);

    expect(fake.orderUpdate).toHaveBeenCalledTimes(1);
    expect(fake.orderUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("createEscalateOnShipmentExceptionHandler — non-escalation kinds", () => {
  it.each(["CREATED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "UNKNOWN"])(
    "no-ops when kind is %s",
    async (kind) => {
      const fake = buildPrismaFake({
        organization: { slug: "acme" },
        actor: { id: USER_ID },
        emergencyBucket: { id: EMERGENCY_BUCKET_ID, siteId: SITE_ID },
        lockedOrder: { currentBucketId: SHIPPING_BUCKET_ID, version: 5 },
      });
      configureBus(fake.client);

      const handler = createEscalateOnShipmentExceptionHandler({ client: fake.client as never });
      const row = buildRow({
        organizationId: ORG_ID,
        shipmentId: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        source: "EASYPOST",
        trackingEventId: TRACKING_EVENT_ID,
        externalEventId: `evt_${kind}`,
        kind,
        carrierStatus: "OK",
        occurredAt: "2026-05-25T15:00:00.000Z",
        cachedStatusAdvanced: true,
      });

      await handler(row, HANDLER_CTX);

      expect(fake.orderUpdate).not.toHaveBeenCalled();
      expect(fake.orderUpdateMany).not.toHaveBeenCalled();
    }
  );
});

describe("createEscalateOnShipmentExceptionHandler — failure modes", () => {
  it("throws when the per-org service user is not seeded", async () => {
    const fake = buildPrismaFake({
      organization: { slug: "acme" },
      actor: null,
      emergencyBucket: { id: EMERGENCY_BUCKET_ID, siteId: SITE_ID },
      lockedOrder: { currentBucketId: SHIPPING_BUCKET_ID, version: 5 },
    });
    configureBus(fake.client);

    const handler = createEscalateOnShipmentExceptionHandler({ client: fake.client as never });
    const row = buildRow({
      organizationId: ORG_ID,
      shipmentId: SHIPMENT_ID,
      orderId: ORDER_ID,
      source: "EASYPOST",
      trackingEventId: TRACKING_EVENT_ID,
      externalEventId: "evt_missing_actor",
      kind: "EXCEPTION",
      carrierStatus: "DE",
      occurredAt: "2026-05-25T15:00:00.000Z",
    });

    await expect(handler(row, HANDLER_CTX)).rejects.toMatchObject({
      code: "ESCALATE_HANDLER_NO_SERVICE_USER",
    });
  });

  it("throws when the payload is missing required fields", async () => {
    const fake = buildPrismaFake({
      organization: { slug: "acme" },
      actor: { id: USER_ID },
      emergencyBucket: { id: EMERGENCY_BUCKET_ID, siteId: SITE_ID },
      lockedOrder: { currentBucketId: SHIPPING_BUCKET_ID, version: 5 },
    });
    configureBus(fake.client);

    const handler = createEscalateOnShipmentExceptionHandler({ client: fake.client as never });
    const row = buildRow({
      organizationId: ORG_ID,
      shipmentId: SHIPMENT_ID,
      // orderId intentionally missing
      source: "EASYPOST",
      trackingEventId: TRACKING_EVENT_ID,
      externalEventId: "evt_bad_payload",
      kind: "EXCEPTION",
      carrierStatus: "DE",
      occurredAt: "2026-05-25T15:00:00.000Z",
    });

    await expect(handler(row, HANDLER_CTX)).rejects.toMatchObject({
      code: "ESCALATE_HANDLER_PAYLOAD_INCOMPLETE",
    });
  });
});
