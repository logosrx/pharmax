// RegisterCarrierCredential contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  decryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
import { CarrierCredentialStatus, RoleScope, ShippingProvider } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { RegisterCarrierCredential } from "./register-carrier-credential.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_MANAGE_CARRIER_CREDENTIALS]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(input: { priorActive?: { id: string } | null; createThrows?: Error }) {
  const calls: FakeCall[] = [];
  let credentialUpdateCalls = 0;

  const tx = {
    carrierCredential: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "carrierCredential", op: "findFirst", args });
        return input.priorActive ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        credentialUpdateCalls += 1;
        calls.push({ table: "carrierCredential", op: "update", args });
        return { id: (input.priorActive ?? { id: "prior" }).id };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "carrierCredential", op: "create", args });
        if (input.createThrows !== undefined) throw input.createThrows;
        return { id: (args as { data: { id: string } }).data.id };
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
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
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
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return {
    client,
    calls,
    get credentialUpdateCalls() {
      return credentialUpdateCalls;
    },
    createArgs(): { data: Record<string, unknown> } | undefined {
      const found = calls.find((c) => c.table === "carrierCredential" && c.op === "create");
      return found?.args as { data: Record<string, unknown> } | undefined;
    },
  };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-24T20:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "register-carrier-credential-test-seed" }) });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("RegisterCarrierCredential — happy path", () => {
  it("encrypts the API key and inserts an ACTIVE row", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterCarrierCredential,
        {
          provider: ShippingProvider.EASYPOST,
          apiKey: "EZTK_demo_api_key",
        },
        { idempotencyKey: "register-easypost-1" }
      )
    );

    expect(out.provider).toBe(ShippingProvider.EASYPOST);
    expect(out.replacedCredentialId).toBeNull();

    const create = fake.createArgs();
    expect(create).toBeDefined();
    const data = create!.data;
    expect(data["provider"]).toBe(ShippingProvider.EASYPOST);
    expect(data["status"]).toBe(CarrierCredentialStatus.ACTIVE);
    expect(data["webhookSecretEnc"]).toBeDefined();

    // Verify the persisted apiKeyEnc decrypts back to the plaintext.
    const apiKeyEnc = data["apiKeyEnc"];
    const credentialId = data["id"] as string;
    const decrypted = await decryptField({
      envelope: apiKeyEnc,
      binding: {
        tenantId: ORG_ID,
        table: "carrier_credential",
        column: "apiKey",
        recordId: credentialId,
      },
    });
    expect(decrypted).toBe("EZTK_demo_api_key");
  });

  it("disables any prior ACTIVE row for the same (org, provider)", async () => {
    const fake = buildPrismaFake({ priorActive: { id: "prior-cred-1" } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterCarrierCredential,
        {
          provider: ShippingProvider.EASYPOST,
          apiKey: "EZTK_new_key",
        },
        { idempotencyKey: "register-rotate-1" }
      )
    );

    expect(out.replacedCredentialId).toBe("prior-cred-1");
    expect(fake.credentialUpdateCalls).toBe(1);
  });

  it("redacts apiKey and webhookSecret from command_log.requestPayload", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterCarrierCredential,
        {
          provider: ShippingProvider.FEDEX,
          apiKey: "fedex_key:fedex_secret",
          webhookSecret: "fedex_whsec_demo",
          carrierAccountId: "123456789",
        },
        { idempotencyKey: "register-redact-1" }
      )
    );

    const preTx = fake.calls.find(
      (c) =>
        c.table === "commandLog" &&
        c.op === "create" &&
        (c.args as { data: { commandName: string } }).data.commandName ===
          "RegisterCarrierCredential"
    );
    expect(preTx).toBeDefined();
    const requestPayload = (preTx!.args as { data: { requestPayload: Record<string, unknown> } })
      .data.requestPayload;
    expect(requestPayload["apiKey"]).toBe("[Redacted]");
    expect(requestPayload["webhookSecret"]).toBe("[Redacted]");
    expect(requestPayload["provider"]).toBe(ShippingProvider.FEDEX);
    expect(requestPayload["carrierAccountId"]).toBe("123456789");
  });
});
