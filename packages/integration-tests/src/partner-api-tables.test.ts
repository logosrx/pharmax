// DB-truth integration tests for the partner-api tables (ADR-0032):
// api_key, webhook_subscription, webhook_delivery. Pins the DB-edge
// guarantees the partner surface relies on:
//
//   (1) RLS isolates api_key across tenants under `pharmax_app`, and
//       fails closed with no tenant GUC — a leaked connection cannot
//       enumerate another org's credentials.
//   (2) The `tokenHash` UNIQUE constraint fires on a duplicate — the
//       O(1) resolution anchor cannot silently alias two keys.
//   (3) `quotaTier` (P0 quota tiers) defaults to STANDARD at the
//       COLUMN level — every key minted before tiers existed, and
//       every writer that omits the column, lands on the tier whose
//       numbers match the pre-tier shared limit — and the enum
//       rejects unknown tiers at the type boundary.
//   (4) The `(subscriptionId, outboxEventId)` UNIQUE index on
//       webhook_delivery — the fan-out idempotency anchor: an outbox
//       redelivery cannot double-book a delivery.
//   (5) RLS isolates webhook_delivery (the partner-visible ledger)
//       across tenants under `pharmax_app`.

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { assertSchemaReady, clearContext, connect, setTenantContext } from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

let owner: Client;
const seededOrgs: string[] = [];

async function seed(): Promise<SeededTenant> {
  const tenant = await seedTenant(owner);
  seededOrgs.push(tenant.organizationId);
  return tenant;
}

async function insertCommandLog(tenant: SeededTenant): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO command_log (
       id, "organizationId", "commandName", "actorUserId",
       "idempotencyKey", "requestPayload", status, "startedAt"
     )
     VALUES ($1, $2, 'CreateApiKey', $3, $4, '{}'::jsonb, 'SUCCEEDED'::"CommandStatus", now())`,
    [id, tenant.organizationId, tenant.adminUserId, `it-${randomUUID()}`]
  );
  return id;
}

async function insertApiKey(input: {
  tenant: SeededTenant;
  commandLogId: string;
  tokenHash?: string;
  quotaTier?: string;
}): Promise<{ id: string; tokenHash: string }> {
  const id = randomUUID();
  const tokenHash = input.tokenHash ?? randomBytes(32).toString("hex");
  const tierColumn = input.quotaTier === undefined ? "" : `, "quotaTier"`;
  const tierValue = input.quotaTier === undefined ? "" : `, $6::"ApiKeyQuotaTier"`;
  const params: unknown[] = [
    id,
    input.tenant.organizationId,
    tokenHash,
    input.tenant.adminUserId,
    input.commandLogId,
  ];
  if (input.quotaTier !== undefined) params.push(input.quotaTier);
  await owner.query(
    `INSERT INTO api_key (
       id, "organizationId", name, "tokenHash", "tokenPrefix", scopes,
       "createdByUserId", "createCommandLogId", "createdAt", "updatedAt"${tierColumn}
     )
     VALUES ($1, $2, 'IT key', $3, 'pxk_test', ARRAY['orders.read'],
             $4, $5, now(), now()${tierValue})`,
    params
  );
  return { id, tokenHash };
}

async function insertSubscription(input: {
  tenant: SeededTenant;
  commandLogId: string;
}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO webhook_subscription (
       id, "organizationId", url, "secretEnc", "eventTypes", status,
       "createdByUserId", "createCommandLogId", "createdAt", "updatedAt"
     )
     VALUES ($1, $2, 'https://partner.example.com/hooks',
             '{"v": "placeholder", "alg": "test"}'::jsonb,
             ARRAY['platform.api_key.created.v1'],
             'ACTIVE'::"WebhookSubscriptionStatus", $3, $4, now(), now())`,
    [id, input.tenant.organizationId, input.tenant.adminUserId, input.commandLogId]
  );
  return id;
}

async function insertDelivery(input: {
  tenant: SeededTenant;
  subscriptionId: string;
  outboxEventId: string;
}): Promise<void> {
  await owner.query(
    `INSERT INTO webhook_delivery (
       id, "organizationId", "subscriptionId", "outboxEventId",
       "eventType", payload, status, attempts, "createdAt"
     )
     VALUES (gen_random_uuid(), $1, $2, $3,
             'platform.api_key.created.v1', '{}'::jsonb,
             'PENDING'::"WebhookDeliveryStatus", 0, now())`,
    [input.tenant.organizationId, input.subscriptionId, input.outboxEventId]
  );
}

beforeAll(async () => {
  await assertSchemaReady();
  owner = await connect("owner");
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

afterEach(async () => {
  for (const orgId of seededOrgs) {
    await owner.query(`DELETE FROM webhook_delivery WHERE "organizationId" = $1`, [orgId]);
    await owner.query(`DELETE FROM webhook_subscription WHERE "organizationId" = $1`, [orgId]);
    await owner.query(`DELETE FROM api_key WHERE "organizationId" = $1`, [orgId]);
    await cleanupTenant(owner, orgId);
  }
  seededOrgs.length = 0;
});

describe("api_key — RLS tenant isolation", () => {
  it("is visible to its own tenant, invisible to another, and fail-closed with no context", async () => {
    const a = await seed();
    const b = await seed();
    const key = await insertApiKey({ tenant: a, commandLogId: await insertCommandLog(a) });

    const app = await connect("app");
    try {
      await setTenantContext(app, a.organizationId);
      const own = await app.query(`SELECT id FROM api_key WHERE id = $1`, [key.id]);
      expect(own.rowCount).toBe(1);

      await setTenantContext(app, b.organizationId);
      const cross = await app.query(`SELECT id FROM api_key WHERE id = $1`, [key.id]);
      expect(cross.rowCount).toBe(0);

      await clearContext(app);
      const none = await app.query(`SELECT id FROM api_key WHERE id = $1`, [key.id]);
      expect(none.rowCount).toBe(0);
    } finally {
      await app.end();
    }
  });
});

describe("api_key — constraints", () => {
  it("rejects a duplicate tokenHash (unique resolution anchor)", async () => {
    const tenant = await seed();
    const commandLogId = await insertCommandLog(tenant);
    const first = await insertApiKey({ tenant, commandLogId });

    await expect(
      insertApiKey({
        tenant,
        commandLogId: await insertCommandLog(tenant),
        tokenHash: first.tokenHash,
      })
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("defaults quotaTier to STANDARD when the writer omits it", async () => {
    const tenant = await seed();
    const key = await insertApiKey({ tenant, commandLogId: await insertCommandLog(tenant) });

    const row = await owner.query(`SELECT "quotaTier" FROM api_key WHERE id = $1`, [key.id]);
    expect(row.rows[0].quotaTier).toBe("STANDARD");
  });

  it("persists an explicit ELEVATED tier and rejects an unknown tier at the enum boundary", async () => {
    const tenant = await seed();
    const elevated = await insertApiKey({
      tenant,
      commandLogId: await insertCommandLog(tenant),
      quotaTier: "ELEVATED",
    });
    const row = await owner.query(`SELECT "quotaTier" FROM api_key WHERE id = $1`, [elevated.id]);
    expect(row.rows[0].quotaTier).toBe("ELEVATED");

    await expect(
      insertApiKey({
        tenant,
        commandLogId: await insertCommandLog(tenant),
        quotaTier: "PLATINUM",
      })
    ).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("webhook_delivery — fan-out idempotency anchor", () => {
  it("rejects a second delivery row for the same (subscription, outbox event)", async () => {
    const tenant = await seed();
    const subscriptionId = await insertSubscription({
      tenant,
      commandLogId: await insertCommandLog(tenant),
    });
    const outboxEventId = randomUUID();

    await insertDelivery({ tenant, subscriptionId, outboxEventId });
    await expect(insertDelivery({ tenant, subscriptionId, outboxEventId })).rejects.toMatchObject({
      code: "23505",
    });

    // A different outbox event books cleanly under the same
    // subscription.
    await insertDelivery({ tenant, subscriptionId, outboxEventId: randomUUID() });
  });

  it("isolates the delivery ledger across tenants under pharmax_app", async () => {
    const a = await seed();
    const b = await seed();
    const subscriptionId = await insertSubscription({
      tenant: a,
      commandLogId: await insertCommandLog(a),
    });
    await insertDelivery({ tenant: a, subscriptionId, outboxEventId: randomUUID() });

    const app = await connect("app");
    try {
      await setTenantContext(app, a.organizationId);
      const own = await app.query(`SELECT id FROM webhook_delivery WHERE "subscriptionId" = $1`, [
        subscriptionId,
      ]);
      expect(own.rowCount).toBe(1);

      await setTenantContext(app, b.organizationId);
      const cross = await app.query(`SELECT id FROM webhook_delivery WHERE "subscriptionId" = $1`, [
        subscriptionId,
      ]);
      expect(cross.rowCount).toBe(0);
    } finally {
      await app.end();
    }
  });
});
