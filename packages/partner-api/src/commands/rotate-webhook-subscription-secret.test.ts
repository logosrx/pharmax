// RotateWebhookSubscriptionSecret contract tests.
//
// The interesting invariants:
//   - the stored value is a ciphertext ENVELOPE (never the raw
//     secret) bound to the SAME AAD tuple as creation;
//   - only ACTIVE subscriptions rotate (a DISABLED endpoint must
//     not be silently re-armed);
//   - the secret is redacted from the hash surface via
//     `hashExcludeFields` so transport retries replay.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
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
  RotateWebhookSubscriptionSecret,
  ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED,
  ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND,
} from "./rotate-webhook-subscription-secret.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-0000000000e1";
// 43 base64url chars after the prefix (matches generateWebhookSecret).
const NEW_SECRET = `pxw_${"a".repeat(43)}`;

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

function buildPrismaFake(input: {
  subscriptionRow?: { id: string; status: string; url: string } | null;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    webhookSubscription: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "webhookSubscription", op: "findUnique", args });
        return input.subscriptionRow ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "webhookSubscription", op: "update", args });
        return { id: SUBSCRIPTION_ID };
      }),
    },
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
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "rotate-secret-test" }) });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("RotateWebhookSubscriptionSecret — happy path", () => {
  it("re-encrypts in place and reports the rotation", async () => {
    const fake = buildPrismaFake({
      subscriptionRow: {
        id: SUBSCRIPTION_ID,
        status: "ACTIVE",
        url: "https://partner.example.com/hooks",
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RotateWebhookSubscriptionSecret,
        { subscriptionId: SUBSCRIPTION_ID, secret: NEW_SECRET },
        { idempotencyKey: "rot-1" }
      )
    );

    expect(out.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(out.url).toBe("https://partner.example.com/hooks");
    expect(out.rotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The persisted value is a ciphertext envelope, never the secret.
    const update = fake.calls.find((c) => c.table === "webhookSubscription" && c.op === "update");
    const data = (update!.args as { data: Record<string, unknown> }).data;
    expect(data["secretEnc"]).toBeDefined();
    expect(JSON.stringify(data["secretEnc"])).not.toContain(NEW_SECRET);
    // Only the envelope changes — status/url/eventTypes are untouched.
    expect(Object.keys(data)).toEqual(["secretEnc"]);

    // Rotation is announced on the outbox (security feed).
    const outbox = fake.calls.find((c) => c.table === "eventOutbox");
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["eventType"]).toBe("platform.webhook_subscription.secret_rotated.v1");
    expect(JSON.stringify(rows[0]!["payload"])).not.toContain(NEW_SECRET);
  });
});

describe("RotateWebhookSubscriptionSecret — guards", () => {
  it("rejects an unknown subscription", async () => {
    const fake = buildPrismaFake({ subscriptionRow: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RotateWebhookSubscriptionSecret,
          { subscriptionId: SUBSCRIPTION_ID, secret: NEW_SECRET },
          { idempotencyKey: "rot-2" }
        )
      )
    ).rejects.toMatchObject({ code: ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_NOT_FOUND });
    expect(fake.tx.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it("refuses to rotate a DISABLED subscription (no silent re-arm)", async () => {
    const fake = buildPrismaFake({
      subscriptionRow: {
        id: SUBSCRIPTION_ID,
        status: "DISABLED",
        url: "https://partner.example.com/hooks",
      },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RotateWebhookSubscriptionSecret,
          { subscriptionId: SUBSCRIPTION_ID, secret: NEW_SECRET },
          { idempotencyKey: "rot-3" }
        )
      )
    ).rejects.toMatchObject({ code: ROTATE_WEBHOOK_SUBSCRIPTION_SECRET_DISABLED });
    expect(fake.tx.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed secret at the schema boundary", async () => {
    const fake = buildPrismaFake({
      subscriptionRow: {
        id: SUBSCRIPTION_ID,
        status: "ACTIVE",
        url: "https://partner.example.com/hooks",
      },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RotateWebhookSubscriptionSecret,
          { subscriptionId: SUBSCRIPTION_ID, secret: "not-a-pxw-secret" },
          { idempotencyKey: "rot-4" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(fake.tx.webhookSubscription.findUnique).not.toHaveBeenCalled();
  });

  it("declares the secret redacted AND hash-excluded (transport retry contract)", () => {
    expect(RotateWebhookSubscriptionSecret.redactFields).toContain("secret");
    expect(RotateWebhookSubscriptionSecret.hashExcludeFields).toContain("secret");
  });
});
