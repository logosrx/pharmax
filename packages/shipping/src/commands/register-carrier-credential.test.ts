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

import {
  REGISTER_CARRIER_CREDENTIAL_BASE_URL_HAS_CREDENTIALS,
  REGISTER_CARRIER_CREDENTIAL_BASE_URL_NON_DEFAULT_PORT,
  REGISTER_CARRIER_CREDENTIAL_BASE_URL_NOT_HTTPS,
  REGISTER_CARRIER_CREDENTIAL_BASE_URL_NOT_PUBLIC,
  RegisterCarrierCredential,
} from "./register-carrier-credential.js";

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
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
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
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
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

describe("RegisterCarrierCredential — SSRF guard on baseUrl", () => {
  // Unlike a webhook endpoint, this destination is dialled WITH THE
  // CARRIER CREDENTIAL ATTACHED: FedEx posts client_id/client_secret
  // to <baseUrl>/oauth/token, UPS sends Basic base64(id:secret), and
  // EasyPost sends the API key as Basic auth on every call. A
  // non-public or attacker-controlled host here is credential
  // exfiltration, not just internal reachability probing — and the
  // tracking pollers re-dial it on every tick. One case per address
  // class; the exhaustive matrix lives beside the guard in
  // platform-core's net/outbound-url.test.ts.
  const nonPublicBaseUrls: ReadonlyArray<readonly [string, string]> = [
    ["IPv4 loopback", "https://127.0.0.1"],
    ["cloud instance metadata", "https://169.254.169.254"],
    ["ECS task metadata", "https://169.254.170.2"],
    ["RFC1918 10/8", "https://10.1.2.3"],
    ["RFC1918 172.16/12", "https://172.20.0.5"],
    ["RFC1918 192.168/16", "https://192.168.10.20"],
    ["carrier-grade NAT", "https://100.64.1.1"],
    ["0.0.0.0/8", "https://0.0.0.0"],
    ["IPv6 loopback", "https://[::1]"],
    ["IPv6 unique-local", "https://[fd00::1]"],
    ["IPv6 link-local", "https://[fe80::1]"],
    ["localhost", "https://localhost"],
    ["mDNS .local name", "https://printer.local"],
    ["private .internal name", "https://vault.internal"],
  ];

  for (const [index, entry] of nonPublicBaseUrls.entries()) {
    const [label, baseUrl] = entry;
    it(`refuses ${label} and writes nothing`, async () => {
      const fake = buildPrismaFake({});
      configureBus(fake.client);

      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(
            RegisterCarrierCredential,
            {
              provider: ShippingProvider.FEDEX,
              apiKey: "fedex_key:fedex_secret",
              carrierAccountId: "123456789",
              baseUrl,
            },
            { idempotencyKey: `rcc-ssrf-${index}` }
          )
        )
      ).rejects.toMatchObject({ code: REGISTER_CARRIER_CREDENTIAL_BASE_URL_NOT_PUBLIC });
      expect(fake.createArgs()).toBeUndefined();
    });
  }

  it("refuses a plaintext http base URL", async () => {
    // `z.string().url()` accepted this, so the OAuth token exchange
    // would have gone out over cleartext with the client secret in
    // the form body.
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RegisterCarrierCredential,
          {
            provider: ShippingProvider.FEDEX,
            apiKey: "fedex_key:fedex_secret",
            carrierAccountId: "123456789",
            baseUrl: "http://apis.fedex.com",
          },
          { idempotencyKey: "rcc-ssrf-http" }
        )
      )
    ).rejects.toMatchObject({ code: REGISTER_CARRIER_CREDENTIAL_BASE_URL_NOT_HTTPS });
    expect(fake.createArgs()).toBeUndefined();
  });

  it("refuses credentials embedded in the base URL", async () => {
    // baseUrl is NOT in redactFields, so userinfo here lands in
    // command_log.requestPayload and the carrier_credential row as
    // plaintext.
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RegisterCarrierCredential,
          {
            provider: ShippingProvider.FEDEX,
            apiKey: "fedex_key:fedex_secret",
            carrierAccountId: "123456789",
            baseUrl: "https://user:pass@apis.fedex.com",
          },
          { idempotencyKey: "rcc-ssrf-creds" }
        )
      )
    ).rejects.toMatchObject({ code: REGISTER_CARRIER_CREDENTIAL_BASE_URL_HAS_CREDENTIALS });
    expect(fake.createArgs()).toBeUndefined();
  });

  it("refuses a non-default port", async () => {
    // No carrier endpoint we target listens off 443, so the port
    // rule is not relaxed for carriers: allowing one would reopen
    // exfiltration to an arbitrary listener on a public host.
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RegisterCarrierCredential,
          {
            provider: ShippingProvider.FEDEX,
            apiKey: "fedex_key:fedex_secret",
            carrierAccountId: "123456789",
            baseUrl: "https://apis.fedex.com:8443",
          },
          { idempotencyKey: "rcc-ssrf-port" }
        )
      )
    ).rejects.toMatchObject({ code: REGISTER_CARRIER_CREDENTIAL_BASE_URL_NON_DEFAULT_PORT });
    expect(fake.createArgs()).toBeUndefined();
  });

  it("leaves a prior ACTIVE credential untouched when the base URL is refused", async () => {
    // The guard runs before the replace step. If it did not, a
    // refused registration would disable the org's working
    // credential and leave shipping with none.
    const fake = buildPrismaFake({ priorActive: { id: "prior-cred-1" } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RegisterCarrierCredential,
          {
            provider: ShippingProvider.FEDEX,
            apiKey: "fedex_key:fedex_secret",
            carrierAccountId: "123456789",
            baseUrl: "https://169.254.169.254",
          },
          { idempotencyKey: "rcc-ssrf-keeps-prior" }
        )
      )
    ).rejects.toMatchObject({ code: REGISTER_CARRIER_CREDENTIAL_BASE_URL_NOT_PUBLIC });
    expect(fake.credentialUpdateCalls).toBe(0);
    expect(fake.createArgs()).toBeUndefined();
  });

  it("accepts every real carrier base URL the clients target", async () => {
    // The evidence that 443-only costs carriers nothing. Production
    // and sandbox/CIE hosts for all three providers are public names
    // on default HTTPS:
    //   FedEx    apis.fedex.com      / apis-sandbox.fedex.com
    //   UPS      onlinetools.ups.com / wwwcie.ups.com
    //   EasyPost api.easypost.com    (test mode selects on key, not host)
    const carrierBaseUrls = [
      "https://apis.fedex.com",
      "https://apis-sandbox.fedex.com",
      "https://onlinetools.ups.com",
      "https://wwwcie.ups.com",
      "https://api.easypost.com",
    ];

    for (const [index, baseUrl] of carrierBaseUrls.entries()) {
      const fake = buildPrismaFake({});
      configureBus(fake.client);

      await withTenancyContext(ctx(), () =>
        executeCommand(
          RegisterCarrierCredential,
          {
            provider: ShippingProvider.FEDEX,
            apiKey: "fedex_key:fedex_secret",
            carrierAccountId: "123456789",
            baseUrl,
          },
          { idempotencyKey: `rcc-ssrf-ok-${index}` }
        )
      );

      expect(fake.createArgs()!.data["baseUrl"]).toBe(baseUrl);
      resetCommandBusConfigurationForTests();
    }
  });
});
