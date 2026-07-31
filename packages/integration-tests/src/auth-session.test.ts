// DB-truth integration tests for the in-house identity engine's session
// tables (ADR-0030). Pins the DB-edge guarantees `resolveSession` relies
// on:
//
//   (1) RLS isolates auth_session across tenants under `pharmax_app`.
//   (2) RLS fail-closed: no tenant GUC ⇒ zero rows.
//   (3) The resolution filter (`revokedAt IS NULL`) — the security
//       property that a REVOKED session is invisible to the very next
//       lookup. This is the capability the stateless-JWT design lacked.
//   (4) The `tokenHash` UNIQUE constraint fires on a duplicate.
//   (5) `login_attempt` is RLS-exempt (platform-level): a `pharmax_app`
//       connection with NO tenant context can still append an attempt
//       (the lockout ledger must work pre-tenant).

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { assertSchemaReady, connect, setTenantContext, clearContext } from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

let owner: Client;
const seededOrgs: string[] = [];

async function seed(): Promise<SeededTenant> {
  const tenant = await seedTenant(owner);
  seededOrgs.push(tenant.organizationId);
  return tenant;
}

function tokenHash(): string {
  return randomBytes(32).toString("hex");
}

async function insertSession(input: {
  organizationId: string;
  userId: string;
  tokenHash: string;
  revoked?: boolean;
}): Promise<void> {
  await owner.query(
    `INSERT INTO auth_session (
       id, "organizationId", "userId", "tokenHash", "mfaSatisfied",
       "createdAt", "lastActivityAt", "idleExpiresAt", "absoluteExpiresAt", "revokedAt"
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, true,
       now(), now(), now() + interval '30 minutes', now() + interval '12 hours', $4
     )`,
    [
      input.organizationId,
      input.userId,
      input.tokenHash,
      input.revoked === true ? new Date() : null,
    ]
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
    await owner.query(`DELETE FROM auth_session WHERE "organizationId" = $1`, [orgId]);
    await owner.query(`DELETE FROM login_attempt WHERE "organizationId" = $1`, [orgId]);
    await cleanupTenant(owner, orgId);
  }
  seededOrgs.length = 0;
});

describe("auth_session — RLS tenant isolation", () => {
  it("is visible to its own tenant and invisible to another under pharmax_app", async () => {
    const a = await seed();
    const b = await seed();
    const th = tokenHash();
    await insertSession({ organizationId: a.organizationId, userId: a.adminUserId, tokenHash: th });

    const app = await connect("app");
    try {
      await setTenantContext(app, a.organizationId);
      const own = await app.query(`SELECT 1 FROM auth_session WHERE "tokenHash" = $1`, [th]);
      expect(own.rowCount).toBe(1);

      await setTenantContext(app, b.organizationId);
      const cross = await app.query(`SELECT 1 FROM auth_session WHERE "tokenHash" = $1`, [th]);
      expect(cross.rowCount).toBe(0);
    } finally {
      await app.end().catch(() => undefined);
    }
  });

  it("fail-closed: no tenant context ⇒ zero rows", async () => {
    const a = await seed();
    const th = tokenHash();
    await insertSession({ organizationId: a.organizationId, userId: a.adminUserId, tokenHash: th });

    const app = await connect("app");
    try {
      await clearContext(app);
      const res = await app.query(`SELECT 1 FROM auth_session WHERE "tokenHash" = $1`, [th]);
      expect(res.rowCount).toBe(0);
    } finally {
      await app.end().catch(() => undefined);
    }
  });
});

describe("auth_session — revocation is immediate", () => {
  it("a revoked session is invisible to the resolution filter (revokedAt IS NULL)", async () => {
    const a = await seed();
    const th = tokenHash();
    await insertSession({ organizationId: a.organizationId, userId: a.adminUserId, tokenHash: th });

    const app = await connect("app");
    try {
      await setTenantContext(app, a.organizationId);
      // Before revoke: the resolution predicate matches.
      const before = await app.query(
        `SELECT 1 FROM auth_session WHERE "tokenHash" = $1 AND "revokedAt" IS NULL`,
        [th]
      );
      expect(before.rowCount).toBe(1);

      // Revoke (what revokeSessionByToken / DeactivateUser do).
      const upd = await app.query(
        `UPDATE auth_session SET "revokedAt" = now(), "revokedReason" = 'USER_LOGOUT'
         WHERE "tokenHash" = $1 AND "revokedAt" IS NULL`,
        [th]
      );
      expect(upd.rowCount).toBe(1);

      // After revoke: the very next resolution lookup sees nothing.
      const after = await app.query(
        `SELECT 1 FROM auth_session WHERE "tokenHash" = $1 AND "revokedAt" IS NULL`,
        [th]
      );
      expect(after.rowCount).toBe(0);
    } finally {
      await app.end().catch(() => undefined);
    }
  });
});

describe("auth_session — tokenHash uniqueness", () => {
  it("rejects a duplicate tokenHash (23505)", async () => {
    const a = await seed();
    const th = tokenHash();
    await insertSession({ organizationId: a.organizationId, userId: a.adminUserId, tokenHash: th });
    await expect(
      insertSession({ organizationId: a.organizationId, userId: a.adminUserId, tokenHash: th })
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("login_attempt — RLS-exempt platform ledger", () => {
  it("accepts an append from pharmax_app with NO tenant context", async () => {
    const a = await seed();
    const app = await connect("app");
    try {
      await clearContext(app);
      // Pre-tenant lockout ledger append must succeed without an org GUC.
      await app.query(
        `INSERT INTO login_attempt (id, "organizationId", "emailAttempted", outcome, "createdAt")
         VALUES (gen_random_uuid(), $1, $2, 'INVALID_CREDENTIALS'::"LoginOutcome", now())`,
        [a.organizationId, `probe-${randomUUID()}@example.test`]
      );
      const seen = await app.query(`SELECT 1 FROM login_attempt WHERE "organizationId" = $1`, [
        a.organizationId,
      ]);
      expect(seen.rowCount).toBe(1);
    } finally {
      await app.end().catch(() => undefined);
    }
  });
});
