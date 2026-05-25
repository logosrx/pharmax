// PurchaseShipmentLabel contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  encryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
import { RoleScope, ShipmentCarrier, ShipmentStatus, ShippingProvider } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import type {
  PurchaseLabelInput,
  PurchasedLabel,
  ShippingAdapter,
} from "../carriers/shipping-adapter.js";
import {
  configureShipping,
  resetShippingConfigurationForTests,
  type CarrierCredentialContext,
  type ShippingAdapterFactory,
} from "../configure.js";

import { PurchaseShipmentLabel, PURCHASE_LABEL_ADAPTER_FAILED } from "./purchase-shipment-label.js";
import { SHIPMENT_ALREADY_EXISTS } from "./create-shipment.js";
import { SHIP_NOT_ASSIGNED_TO_ACTOR, SHIP_WRONG_STATUS } from "../shipping-guards.js";

const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000a1";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_PURCHASE_LABEL]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

function validInput() {
  return {
    orderId: ORDER_ID,
    provider: ShippingProvider.EASYPOST,
    carrier: ShipmentCarrier.USPS,
    serviceLevel: "Priority",
    fromAddress: {
      name: "Pharmax Outbound",
      street1: "1 Pharmacy Way",
      city: "Brooklyn",
      state: "NY",
      postalCode: "11201",
      country: "US",
    },
    toAddress: {
      name: "Recipient Demo",
      street1: "100 Sample St",
      city: "Brooklyn",
      state: "NY",
      postalCode: "11201",
      country: "US",
    },
    parcel: { lengthInches: 6, widthInches: 4, heightInches: 2, weightOunces: 8 },
  };
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface CarrierCredentialFake {
  readonly id: string;
  readonly apiKeyEnc: unknown;
  readonly webhookSecretEnc: unknown | null;
  readonly carrierAccountId: string | null;
  readonly baseUrl: string | null;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  assigneeUserId?: string | null;
  existingShipment?: { id: string } | null;
  orderUpdateManyCount?: number;
  orderEventHead?: { sequenceNumber: number } | null;
  carrierCredential?: CarrierCredentialFake | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "READY_TO_SHIP", version: 9 }
      : overrides.lockedRow;
  const assigneeUserId =
    overrides.assigneeUserId === undefined ? USER_ID : overrides.assigneeUserId;
  const existingShipment =
    "existingShipment" in overrides ? (overrides.existingShipment ?? null) : null;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 9 };
  const carrierCredential =
    "carrierCredential" in overrides ? overrides.carrierCredential : defaultCredential;

  const tx = {
    carrierCredential: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "carrierCredential", op: "findFirst", args });
        return carrierCredential;
      }),
    },
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: assigneeUserId };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    shipment: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "findFirst", args });
        return existingShipment;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "create", args });
        return { id: SHIPMENT_ID };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-10" };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        return { organizationId: ORG_ID, latestHash: Buffer.alloc(32), latestSeq: 1n };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
    },
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      const op =
        /\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)
          ? "select_for_update_order"
          : "raw";
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
      if (op === "select_for_update_order") {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                clinicId: CLINIC_ID,
                siteId: SITE_ID,
                currentStatus: lockedRow.currentStatus,
                version: lockedRow.version,
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
              },
            ];
      }
      return [];
    }),
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        calls.push({
          table: "$executeRaw",
          op: "set_config",
          args: { sql: template.join("?"), values: [...values] },
        });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T16:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

type StubFactoryAdapter = ShippingAdapter & {
  purchaseLabel: ReturnType<typeof vi.fn>;
};

function fakeAdapter(overrides: Partial<PurchasedLabel> = {}): StubFactoryAdapter {
  const purchaseLabel = vi.fn(
    async (_input: PurchaseLabelInput): Promise<PurchasedLabel> => ({
      carrier: ShipmentCarrier.USPS,
      serviceLevel: "Priority",
      trackingNumber: "9400111899223344556677",
      externalShipmentId: "shp_demo",
      externalTrackerId: "trk_demo",
      labelUrl: "https://example.invalid/label.png",
      labelPdfBase64: null,
      postageRateCents: 940,
      ...overrides,
    })
  );
  return { providerName: "stub", purchaseLabel };
}

function stubFactory(adapter: ShippingAdapter): ShippingAdapterFactory {
  return (_ctx: CarrierCredentialContext) => adapter;
}

function configureShippingWithFakeAdapter(adapter: ShippingAdapter): void {
  configureShipping({ factories: { [ShippingProvider.EASYPOST]: stubFactory(adapter) } });
}

// The resolver decrypts `apiKeyEnc` via @pharmax/crypto. We pre-encrypt
// a throwaway plaintext at test setup with the same binding the
// resolver will use, so the round-trip succeeds. The plaintext value
// itself is irrelevant — the stub factory ignores ctx.apiKey.
let defaultCredential: {
  id: string;
  apiKeyEnc: unknown;
  webhookSecretEnc: unknown | null;
  carrierAccountId: string | null;
  baseUrl: string | null;
};

beforeEach(async () => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "purchase-shipment-label-test-seed" }) });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
  const apiKeyEnc = await encryptField({
    plaintext: "stub-api-key",
    binding: {
      tenantId: ORG_ID,
      table: "carrier_credential",
      column: "apiKey",
      recordId: CREDENTIAL_ID,
    },
  });
  defaultCredential = {
    id: CREDENTIAL_ID,
    apiKeyEnc,
    webhookSecretEnc: null,
    carrierAccountId: null,
    baseUrl: null,
  };
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetShippingConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("PurchaseShipmentLabel — happy path", () => {
  it("calls the adapter and persists a shipment row with the carrier-derived fields", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const adapter = fakeAdapter();
    configureShippingWithFakeAdapter(adapter);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(PurchaseShipmentLabel, validInput(), {
        idempotencyKey: "purchase-1",
      })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      shipmentId: SHIPMENT_ID,
      provider: ShippingProvider.EASYPOST,
      trackingNumber: "9400111899223344556677",
      externalShipmentId: "shp_demo",
      externalTrackerId: "trk_demo",
      labelUrl: "https://example.invalid/label.png",
      postageRateCents: 940,
      version: 10,
    });

    expect(adapter.purchaseLabel).toHaveBeenCalledTimes(1);

    const createArgs = (
      callsOf(fake.calls, "shipment", "create")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(createArgs).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      status: ShipmentStatus.CREATED,
      carrier: ShipmentCarrier.USPS,
      serviceLevel: "Priority",
      trackingNumber: "9400111899223344556677",
      externalShipmentId: "shp_demo",
      externalTrackerId: "trk_demo",
    });

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    const eventTypes = outboxRows.map((r) => r["eventType"]);
    expect(eventTypes).toEqual(
      expect.arrayContaining(["order.shipment.label_purchased.v1", "order.shipment.created.v1"])
    );
  });

  it("redacts fromAddress and toAddress from command_log.requestPayload", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    configureShippingWithFakeAdapter(fakeAdapter());

    await withTenancyContext(ctxFor(), () =>
      executeCommand(PurchaseShipmentLabel, validInput(), {
        idempotencyKey: "purchase-redact-1",
      })
    );

    const preTxCommandLogCreate = callsOf(fake.calls, "commandLog", "create").find((c) => {
      const data = (c.args as { data: Record<string, unknown> }).data;
      return data["commandName"] === "PurchaseShipmentLabel";
    });
    expect(preTxCommandLogCreate).toBeDefined();
    const requestPayload = (
      preTxCommandLogCreate!.args as { data: { requestPayload: Record<string, unknown> } }
    ).data.requestPayload;
    expect(requestPayload["fromAddress"]).toBe("[Redacted]");
    expect(requestPayload["toAddress"]).toBe("[Redacted]");
    // Non-PHI fields stay visible for replay/debug.
    expect(requestPayload["carrier"]).toBe(ShipmentCarrier.USPS);
    expect(requestPayload["serviceLevel"]).toBe("Priority");
  });
});

describe("PurchaseShipmentLabel — preconditions", () => {
  it("rejects when a shipment already exists for the order", async () => {
    const fake = buildPrismaFake({ existingShipment: { id: "shp-existing" } });
    configureBus(fake.client);
    configureShippingWithFakeAdapter(fakeAdapter());

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PurchaseShipmentLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: SHIPMENT_ALREADY_EXISTS });
    });
  });

  it("rejects when the order is in the wrong status", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_IN_PROGRESS", version: 4 },
    });
    configureBus(fake.client);
    configureShippingWithFakeAdapter(fakeAdapter());

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PurchaseShipmentLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: SHIP_WRONG_STATUS });
    });
  });

  it("rejects when the order is not assigned to the caller", async () => {
    const fake = buildPrismaFake({ assigneeUserId: "00000000-0000-4000-8000-00000000ffff" });
    configureBus(fake.client);
    configureShippingWithFakeAdapter(fakeAdapter());

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PurchaseShipmentLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: SHIP_NOT_ASSIGNED_TO_ACTOR });
    });
  });
});

describe("PurchaseShipmentLabel — adapter failure", () => {
  it("wraps adapter errors as PURCHASE_LABEL_ADAPTER_FAILED and writes no shipment row", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    configureShippingWithFakeAdapter({
      providerName: "stub",
      purchaseLabel: async () => {
        throw new Error("downstream 500");
      },
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PurchaseShipmentLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: PURCHASE_LABEL_ADAPTER_FAILED });
    });
    expect(callsOf(fake.calls, "shipment", "create")).toHaveLength(0);
  });
});

describe("PurchaseShipmentLabel — credential missing", () => {
  it("rejects with SHIPPING_CREDENTIAL_NOT_FOUND when no ACTIVE credential exists", async () => {
    const fake = buildPrismaFake({ carrierCredential: null });
    configureBus(fake.client);
    configureShippingWithFakeAdapter(fakeAdapter());

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(PurchaseShipmentLabel, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "SHIPPING_CREDENTIAL_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "shipment", "create")).toHaveLength(0);
  });
});
