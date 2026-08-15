// CreateWebhookSubscription contract tests.
//
// The invariants pinned here:
//   - the raw `pxw_` signing secret is stored ONLY as a ciphertext
//     envelope and never reaches the row, the audit metadata, the
//     outbox payload, or the command output;
//   - the endpoint is HTTPS and the subscribed event types are the
//     registry's phi-safe subset, so a phi-bearing event cannot be
//     routed off-platform;
//   - the row is written into the caller's own organization;
//   - the secret is excluded from the idempotency hash surface so
//     transport retries replay instead of 409ing.

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
import { RoleScope } from "@pharmax/database";
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
  CreateWebhookSubscription,
  CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT,
  CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS,
} from "./create-webhook-subscription.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000ff";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const ENDPOINT_URL = "https://partner.example.com/hooks";
// 43 base64url chars after the prefix (matches generateWebhookSecret).
const SECRET = `pxw_${"b".repeat(43)}`;
const EVENT_TYPE = "platform.api_key.created.v1";

const VALID_INPUT = {
  url: ENDPOINT_URL,
  eventTypes: [EVENT_TYPE],
  description: "Acme telehealth receiver",
  secret: SECRET,
};

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.WEBHOOKS_MANAGE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake() {
  const calls: FakeCall[] = [];

  const tx = {
    webhookSubscription: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "webhookSubscription", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
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
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-07-31T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_USER_ID, grants },
    ]),
  });
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "create-webhook-subscription-test" }) });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

function createdRowData(calls: ReadonlyArray<FakeCall>) {
  const create = calls.find((c) => c.table === "webhookSubscription" && c.op === "create");
  return (create!.args as { data: Record<string, unknown> }).data;
}

/** Audit rows carry a bigint chain sequence, which `JSON.stringify` refuses. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

describe("CreateWebhookSubscription — happy path", () => {
  it("registers the endpoint in the caller's own organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateWebhookSubscription, VALID_INPUT, { idempotencyKey: "cws-1" })
    );

    const data = createdRowData(fake.calls);
    // A row filed under the wrong org would fan another tenant's
    // events out to this partner.
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["url"]).toBe(ENDPOINT_URL);
    expect(data["eventTypes"]).toEqual([EVENT_TYPE]);
    expect(data["createdByUserId"]).toBe(ACTOR_USER_ID);

    expect(out.subscriptionId).toBe(data["id"]);
    expect(out.status).toBe("ACTIVE");
    expect(out.eventTypes).toEqual([EVENT_TYPE]);
  });

  it("de-duplicates repeated event types before persisting", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateWebhookSubscription,
        { ...VALID_INPUT, eventTypes: [EVENT_TYPE, EVENT_TYPE] },
        { idempotencyKey: "cws-2" }
      )
    );

    expect(out.eventTypes).toEqual([EVENT_TYPE]);
    expect(createdRowData(fake.calls)["eventTypes"]).toEqual([EVENT_TYPE]);
  });

  it("binds the stored envelope to the row it was created for", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(CreateWebhookSubscription, VALID_INPUT, { idempotencyKey: "cws-3" })
    );

    const data = createdRowData(fake.calls);
    const binding = {
      tenantId: ORG_ID,
      table: "webhook_subscription",
      column: "secret",
      recordId: data["id"] as string,
    };
    await expect(decryptField({ envelope: data["secretEnc"], binding })).resolves.toBe(SECRET);

    // The AAD names the record, so a ciphertext lifted into another
    // tenant's row cannot be decrypted there.
    await expect(
      decryptField({ envelope: data["secretEnc"], binding: { ...binding, tenantId: OTHER_ORG_ID } })
    ).rejects.toThrow();
  });
});

describe("CreateWebhookSubscription — secret hygiene", () => {
  it("never writes or emits the raw signing secret anywhere", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateWebhookSubscription, VALID_INPUT, { idempotencyKey: "cws-4" })
    );

    // The secret is the partner's only proof a delivery came from
    // us; a plaintext copy in any of these surfaces is a leak that
    // outlives the request.
    const data = createdRowData(fake.calls);
    expect(data["secretEnc"]).toBeDefined();
    expect(data["secret"]).toBeUndefined();
    for (const call of fake.calls) {
      expect(serialize(call.args)).not.toContain(SECRET);
    }
    expect(serialize(out)).not.toContain(SECRET);
  });

  it("declares the secret redacted AND hash-excluded (transport retry contract)", () => {
    expect(CreateWebhookSubscription.redactFields).toContain("secret");
    expect(CreateWebhookSubscription.hashExcludeFields).toContain("secret");
  });

  it("rejects a malformed secret at the schema boundary", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateWebhookSubscription,
          { ...VALID_INPUT, secret: "not-a-pxw-secret" },
          { idempotencyKey: "cws-5" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(fake.tx.webhookSubscription.create).not.toHaveBeenCalled();
  });
});

describe("CreateWebhookSubscription — endpoint and event guards", () => {
  it("refuses a plaintext http endpoint", async () => {
    // Signed payloads over http would put event data — and the
    // signature — on the wire in the clear.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateWebhookSubscription,
          { ...VALID_INPUT, url: "http://partner.example.com/hooks" },
          { idempotencyKey: "cws-6" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_WEBHOOK_SUBSCRIPTION_URL_NOT_HTTPS });
    expect(fake.tx.webhookSubscription.create).not.toHaveBeenCalled();
  });

  it("refuses an event type that is not a registered phi-safe event", async () => {
    // Eligibility is derived from the registry's phiSafe flag, so
    // this is what stops PHI from being routed off-platform.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateWebhookSubscription,
          // (Allowlisted parity-guard fixture name — intentionally unregistered.)
          { ...VALID_INPUT, eventTypes: ["some.unregistered.event.v1"] },
          { idempotencyKey: "cws-7" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT });
    expect(fake.tx.webhookSubscription.create).not.toHaveBeenCalled();
  });

  it("refuses the whole subscription when only one event type is ineligible", async () => {
    // Partial acceptance would silently register a subscription
    // the operator did not ask for.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateWebhookSubscription,
          // (Allowlisted parity-guard fixture name — intentionally unregistered.)
          { ...VALID_INPUT, eventTypes: [EVENT_TYPE, "some.unregistered.event.v1"] },
          { idempotencyKey: "cws-8" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_WEBHOOK_SUBSCRIPTION_INELIGIBLE_EVENT });
    expect(fake.tx.webhookSubscription.create).not.toHaveBeenCalled();
  });

  it("requires at least one event type", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateWebhookSubscription,
          { ...VALID_INPUT, eventTypes: [] },
          { idempotencyKey: "cws-9" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(fake.tx.webhookSubscription.create).not.toHaveBeenCalled();
  });
});

describe("CreateWebhookSubscription — audit and outbox", () => {
  it("announces the new endpoint on the security feed", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateWebhookSubscription, VALID_INPUT, { idempotencyKey: "cws-10" })
    );

    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const auditData = (audit!.args as { data: { action: string; resourceId: string } }).data;
    expect(auditData.action).toBe("platform.webhook_subscription.created");
    expect(auditData.resourceId).toBe(out.subscriptionId);

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["eventType"]).toBe("platform.webhook_subscription.created.v1");
    const payload = rows[0]!["payload"] as Record<string, unknown>;
    expect(payload["organizationId"]).toBe(ORG_ID);
    expect(payload["createdByUserId"]).toBe(ACTOR_USER_ID);
  });
});
