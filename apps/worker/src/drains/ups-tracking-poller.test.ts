// Unit tests for the UPS tracking poller. Mirrors the FedEx version:
// real `withSystemContext` / `withTenancyContext` / command bus,
// stubbed Prisma surface and UPS HTTP transport.

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import {
  configureCrypto,
  encryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
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

import { createUpsTrackingPoller } from "./ups-tracking-poller.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";
const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000a1";
const TRACKING_NUMBER = "1Z999AA10123456784";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_RECORD_TRACKING_EVENT]),
  },
];

interface BuildClientInput {
  claimRows: Array<Record<string, unknown>>;
  credential: Record<string, unknown> | null;
  organization: { slug: string } | null;
  actor: { id: string } | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildPrismaFake(input: BuildClientInput) {
  const shipmentTrackingEventCreate = vi.fn(async () => ({ id: "ste-1" }));
  const shipmentUpdate = vi.fn(async () => ({ id: SHIPMENT_ID }));

  const shipmentFindFirst = vi.fn(async () => ({
    id: SHIPMENT_ID,
    orderId: "00000000-0000-4000-8000-000000000aaa",
    siteId: SITE_ID,
    status: "CREATED",
    lastTrackingEventAt: null,
    lastTrackingEventKind: null,
  }));

  const tx = {
    shipment: { findFirst: shipmentFindFirst, update: shipmentUpdate },
    shipmentTrackingEvent: { create: shipmentTrackingEventCreate },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
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
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    $queryRaw: vi.fn(async () => input.claimRows),
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    carrierCredential: {
      findFirst: vi.fn(async () => input.credential),
    },
    organization: {
      findUnique: vi.fn(async () => input.organization),
    },
    user: {
      findFirst: vi.fn(async () => input.actor),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
  };

  return { client, shipmentTrackingEventCreate };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-25T12:00:00.000Z")),
    logger: loggerNs.noopLogger,
  });
}

async function buildEncryptedApiKey(): Promise<unknown> {
  return await encryptField({
    plaintext: "ups_client_id:ups_client_secret",
    binding: {
      tenantId: ORG_ID,
      table: "carrier_credential",
      column: "apiKey",
      recordId: CREDENTIAL_ID,
    },
  });
}

function upsFetchStub(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {})
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "ups-tracking-poller-test-seed" }) });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("createUpsTrackingPoller.tick — happy path", () => {
  it("polls active UPS shipments, normalizes the status, and records the event", async () => {
    const apiKeyEnc = await buildEncryptedApiKey();
    const fake = buildPrismaFake({
      claimRows: [
        {
          id: SHIPMENT_ID,
          organizationId: ORG_ID,
          siteId: SITE_ID,
          trackingNumber: TRACKING_NUMBER,
          lastTrackingEventAt: null,
        },
      ],
      credential: {
        id: CREDENTIAL_ID,
        apiKeyEnc,
        carrierAccountId: "AB1234",
        baseUrl: null,
      },
      organization: { slug: "acme" },
      actor: { id: USER_ID },
    });
    configureBus(fake.client);

    const upsFetch = upsFetchStub((url) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse({ access_token: "tok", expires_in: "14400", token_type: "Bearer" });
      }
      if (url.includes("/api/track/v1/details/")) {
        return jsonResponse({
          trackResponse: {
            shipment: [
              {
                package: [
                  {
                    trackingNumber: TRACKING_NUMBER,
                    currentStatus: { type: "D", description: "Delivered" },
                    activity: [
                      {
                        date: "20260525",
                        time: "143000",
                        status: { type: "D", description: "Delivered" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });

    const poller = createUpsTrackingPoller(
      {
        client: fake.client as never,
        logger: loggerNs.noopLogger,
        actorEmailLocalPart: "shipping-webhook",
        upsFetch,
      },
      { batchSize: 50, staleThresholdMs: 7_200_000 }
    );

    const result = await poller.tick();

    expect(result.claimed).toBe(1);
    expect(result.polled).toBe(1);
    expect(result.recorded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skippedNoCredential).toBe(0);
    expect(result.skippedNoStatus).toBe(0);

    expect(fake.shipmentTrackingEventCreate).toHaveBeenCalledTimes(1);
    const firstCall = fake.shipmentTrackingEventCreate.mock.calls[0] as unknown as Array<unknown>;
    const createArgs = firstCall[0] as { data: Record<string, unknown> };
    expect(createArgs.data["source"]).toBe("UPS");
    expect(createArgs.data["kind"]).toBe("DELIVERED");
    expect(createArgs.data["carrierStatus"]).toBe("D");
    expect(String(createArgs.data["externalEventId"])).toContain(`ups:${TRACKING_NUMBER}:D`);
  });
});

describe("createUpsTrackingPoller.tick — skip paths", () => {
  it("skips the whole org when no ACTIVE UPS credential is configured", async () => {
    const fake = buildPrismaFake({
      claimRows: [
        {
          id: SHIPMENT_ID,
          organizationId: ORG_ID,
          siteId: SITE_ID,
          trackingNumber: TRACKING_NUMBER,
          lastTrackingEventAt: null,
        },
      ],
      credential: null,
      organization: { slug: "acme" },
      actor: { id: USER_ID },
    });
    configureBus(fake.client);

    const upsFetch = upsFetchStub(() => {
      throw new Error("UPS HTTP should not be called when credential missing");
    });

    const poller = createUpsTrackingPoller(
      { client: fake.client as never, logger: loggerNs.noopLogger, upsFetch },
      { batchSize: 50, staleThresholdMs: 7_200_000 }
    );

    const result = await poller.tick();
    expect(result.skippedNoCredential).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("returns zeros when no shipments are due", async () => {
    const fake = buildPrismaFake({
      claimRows: [],
      credential: null,
      organization: null,
      actor: null,
    });
    configureBus(fake.client);
    const poller = createUpsTrackingPoller(
      { client: fake.client as never, logger: loggerNs.noopLogger },
      { batchSize: 50, staleThresholdMs: 7_200_000 }
    );
    const result = await poller.tick();
    expect(result).toEqual({
      claimed: 0,
      polled: 0,
      recorded: 0,
      skippedNoCredential: 0,
      skippedNoStatus: 0,
      failed: 0,
    });
  });

  it("counts skippedNoStatus when UPS returns a package with no currentStatus.type", async () => {
    const apiKeyEnc = await buildEncryptedApiKey();
    const fake = buildPrismaFake({
      claimRows: [
        {
          id: SHIPMENT_ID,
          organizationId: ORG_ID,
          siteId: SITE_ID,
          trackingNumber: TRACKING_NUMBER,
          lastTrackingEventAt: null,
        },
      ],
      credential: { id: CREDENTIAL_ID, apiKeyEnc, carrierAccountId: "AB1234", baseUrl: null },
      organization: { slug: "acme" },
      actor: { id: USER_ID },
    });
    configureBus(fake.client);

    const upsFetch = upsFetchStub((url) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse({ access_token: "tok", expires_in: "14400", token_type: "Bearer" });
      }
      if (url.includes("/api/track/v1/details/")) {
        return jsonResponse({
          trackResponse: {
            shipment: [{ package: [{ trackingNumber: TRACKING_NUMBER, activity: [] }] }],
          },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });

    const poller = createUpsTrackingPoller(
      { client: fake.client as never, logger: loggerNs.noopLogger, upsFetch },
      { batchSize: 50, staleThresholdMs: 7_200_000 }
    );

    const result = await poller.tick();
    expect(result.skippedNoStatus).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("counts failed when UPS returns a 4xx error for the tracking number", async () => {
    const apiKeyEnc = await buildEncryptedApiKey();
    const fake = buildPrismaFake({
      claimRows: [
        {
          id: SHIPMENT_ID,
          organizationId: ORG_ID,
          siteId: SITE_ID,
          trackingNumber: TRACKING_NUMBER,
          lastTrackingEventAt: null,
        },
      ],
      credential: { id: CREDENTIAL_ID, apiKeyEnc, carrierAccountId: "AB1234", baseUrl: null },
      organization: { slug: "acme" },
      actor: { id: USER_ID },
    });
    configureBus(fake.client);

    const upsFetch = upsFetchStub((url) => {
      if (url.endsWith("/security/v1/oauth/token")) {
        return jsonResponse({ access_token: "tok", expires_in: "14400", token_type: "Bearer" });
      }
      return new Response("not found", { status: 404 });
    });

    const poller = createUpsTrackingPoller(
      { client: fake.client as never, logger: loggerNs.noopLogger, upsFetch },
      { batchSize: 50, staleThresholdMs: 7_200_000 }
    );

    const result = await poller.tick();
    expect(result.failed).toBe(1);
    expect(result.recorded).toBe(0);
  });
});
