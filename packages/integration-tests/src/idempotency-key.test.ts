// DB-truth integration tests for `idempotency_key`.
//
// The idempotency_key table is the load-bearing guard for the
// "every critical command requires an idempotency key" rule
// (ADR-0007 step 6). The unit-test layer covers the command-bus
// idempotency middleware behaviorally; this suite proves the
// DB-edge invariants the middleware relies on:
//
//   (1) The UNIQUE (organizationId, commandName, key) constraint
//       actually fires (Postgres SQLSTATE 23505 unique_violation).
//       Without this, two concurrent retries of the same command
//       could both pass the in-app "look up prior result" check
//       and execute the side effect twice.
//
//   (2) The constraint is SCOPED to the tenant: the SAME idempotency
//       key under a DIFFERENT organization is permitted. This
//       proves there is no global key namespace bleeding across
//       tenants — a SOC 2 isolation requirement that fake-Prisma
//       tests cannot structurally verify.
//
//   (3) The constraint is SCOPED to the command: the SAME key under
//       the SAME tenant but for a DIFFERENT command is permitted.
//       This matches the production middleware's keying strategy
//       (`(orgId, commandName, idempotencyKey)`) and rules out a
//       schema regression to a more permissive UNIQUE shape.
//
// All three tests run as `pharmax_app` with the tenant GUC set,
// so they exercise the runtime role + RLS path the production
// command bus takes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { assertSchemaReady, connect, setSystemContext, setTenantContext } from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

const COMMAND_A = "TestCommandA";
const COMMAND_B = "TestCommandB";

interface InsertIdempotencyKeyArgs {
  readonly client: Client;
  readonly organizationId: string;
  readonly commandName: string;
  readonly key: string;
}

async function insertIdempotencyKey(args: InsertIdempotencyKeyArgs): Promise<void> {
  await args.client.query(
    `INSERT INTO idempotency_key (
       id, "organizationId", "commandName", "key", "requestHash", "createdAt"
     )
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
    [args.organizationId, args.commandName, args.key, `req-${randomUUID()}`]
  );
}

describe("idempotency_key — DB-truth integration", () => {
  let ownerClient: Client;
  let appClient: Client;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    await assertSchemaReady();
    ownerClient = await connect("owner");
    appClient = await connect("app");

    await setSystemContext(ownerClient);
    tenantA = await seedTenant(ownerClient);
    tenantB = await seedTenant(ownerClient);
  });

  afterAll(async () => {
    await setSystemContext(ownerClient);
    await cleanupTenant(ownerClient, tenantA.organizationId);
    await cleanupTenant(ownerClient, tenantB.organizationId);
    await ownerClient.end();
    await appClient.end();
  });

  it("UNIQUE (organizationId, commandName, key) fires on a duplicate insert (23505)", async () => {
    await setTenantContext(appClient, tenantA.organizationId);
    const key = `idem-${randomUUID()}`;

    await insertIdempotencyKey({
      client: appClient,
      organizationId: tenantA.organizationId,
      commandName: COMMAND_A,
      key,
    });

    let error: unknown = undefined;
    try {
      await insertIdempotencyKey({
        client: appClient,
        organizationId: tenantA.organizationId,
        commandName: COMMAND_A,
        key,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const code = (error as { code?: string }).code;
    expect(code, `expected 23505 unique_violation; got ${String(code)}`).toBe("23505");
    const constraint = (error as { constraint?: string }).constraint;
    expect(constraint).toBe("idempotency_key_organizationId_commandName_key_key");
  });

  it("the SAME key + command under a DIFFERENT organization is permitted (no global key bleed across tenants)", async () => {
    const key = `idem-${randomUUID()}`;

    // Tenant A claims the key.
    await setTenantContext(appClient, tenantA.organizationId);
    await insertIdempotencyKey({
      client: appClient,
      organizationId: tenantA.organizationId,
      commandName: COMMAND_A,
      key,
    });

    // Tenant B uses the EXACT same key + command — must succeed.
    await setTenantContext(appClient, tenantB.organizationId);
    await expect(
      insertIdempotencyKey({
        client: appClient,
        organizationId: tenantB.organizationId,
        commandName: COMMAND_A,
        key,
      })
    ).resolves.toBeUndefined();
  });

  it("the SAME key + tenant under a DIFFERENT command is permitted (the UNIQUE includes commandName)", async () => {
    await setTenantContext(appClient, tenantA.organizationId);
    const key = `idem-${randomUUID()}`;

    await insertIdempotencyKey({
      client: appClient,
      organizationId: tenantA.organizationId,
      commandName: COMMAND_A,
      key,
    });
    await expect(
      insertIdempotencyKey({
        client: appClient,
        organizationId: tenantA.organizationId,
        commandName: COMMAND_B,
        key,
      })
    ).resolves.toBeUndefined();
  });
});
