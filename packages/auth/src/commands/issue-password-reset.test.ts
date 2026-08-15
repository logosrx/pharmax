// IssuePasswordReset contract tests (bus-integrated, DB-free).
//
// This command mints the bearer credential that the whole reset flow
// trusts, so the tests pin the secret-handling properties: only a
// SHA-256 hash is persisted, the raw token stays out of audit_log,
// event_outbox, and command_log, every call mints fresh entropy, and
// prior unused links are swept BEFORE the new one is created.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import { hashSessionToken } from "../session/token.js";
import { IssuePasswordReset } from "./issue-password-reset.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-07-13T12:00:00.000Z");
const TTL_MS = 15 * 60 * 1000;

const fakeHasher: PasswordHasher = {
  async hash(p) {
    return `h:${p}`;
  },
  async verify(h, p) {
    return h === `h:${p}`;
  },
  needsRehash() {
    return false;
  },
};

function buildFake() {
  const tx = {
    passwordResetToken: {
      create: vi.fn(async (_args: unknown) => ({ id: "prt-1" })),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cmd-log-1" })),
      update: vi.fn(async (_args: unknown) => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({ id: "audit-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
}

function run() {
  return withSystemContext("test:issue-password-reset", () =>
    executeSystemCommand(IssuePasswordReset, { userId: USER_ID, organizationId: ORG_ID })
  );
}

/** JSON.stringify that tolerates the bigint `seq` on an audit row. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v
  );
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      resetTokenTtlMs: TTL_MS,
    })
  );
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("IssuePasswordReset", () => {
  it("returns the raw token to the caller but persists only its hash", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    const creates = fake.tx.passwordResetToken.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { organizationId: string; userId: string; tokenHash: string } }]
    >;
    const row = creates[0]![0].data;
    expect(row.organizationId).toBe(ORG_ID);
    expect(row.userId).toBe(USER_ID);
    expect(row.tokenHash).toBe(hashSessionToken(out.rawToken));
    // A database-only compromise must not yield usable reset links, so
    // the raw token may not appear anywhere in the persisted row.
    expect(serialize(row)).not.toContain(out.rawToken);
  });

  it("expires the link after the configured TTL", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    // Read from configuration, not hard-coded: a deployment that
    // shortens the exposure window has to actually take effect.
    expect(out.expiresAt.getTime()).toBe(NOW.getTime() + TTL_MS);
    const creates = fake.tx.passwordResetToken.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { expiresAt: Date } }]
    >;
    expect(creates[0]![0].data.expiresAt.getTime()).toBe(NOW.getTime() + TTL_MS);
  });

  it("mints unguessable, distinct token material on every call", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const a = await run();
    const b = await run();

    // Two links for the same user must not collide: a derivable or
    // reused token means holding one person's link forges everyone's.
    expect(a.rawToken).not.toBe(b.rawToken);
    // 32 random bytes, base64url — 43 chars is the floor for 256 bits.
    expect(a.rawToken.length).toBeGreaterThanOrEqual(43);
  });

  it("invalidates prior unused links before minting the new one", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run();

    const sweeps = fake.tx.passwordResetToken.updateMany.mock.calls as unknown as ReadonlyArray<
      readonly [{ where: { userId: string; usedAt: null }; data: { usedAt: Date } }]
    >;
    expect(sweeps[0]![0].where).toEqual({ userId: USER_ID, usedAt: null });
    expect(sweeps[0]![0].data.usedAt).toEqual(NOW);
    // Order matters: the sweep matches "every unused token for this
    // user", so running it after the insert would consume the token
    // just minted and mail out a link that is already dead.
    expect(fake.tx.passwordResetToken.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      fake.tx.passwordResetToken.create.mock.invocationCallOrder[0]!
    );
  });

  it("audits the request without recording the token", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    const audits = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { action: string; resourceId: string; metadata: Record<string, unknown> } }]
    >;
    expect(audits[0]![0].data.action).toBe("user.password_reset_requested");
    expect(audits[0]![0].data.resourceId).toBe(USER_ID);
    expect(audits[0]![0].data.metadata["expiresAt"]).toBe(out.expiresAt.toISOString());
    // audit_log is broadly readable by compliance reviewers; a token
    // that leaks into it is a reset link with an audience.
    expect(serialize(audits[0]![0].data)).not.toContain(out.rawToken);
  });

  it("publishes a token-free outbox event", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    const outbox = fake.tx.eventOutbox.createMany.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: ReadonlyArray<{ eventType: string; aggregateId: string }> }]
    >;
    const events = outbox[0]![0].data;
    expect(events[0]!.eventType).toBe("user.password_reset_requested.v1");
    expect(events[0]!.aggregateId).toBe(USER_ID);
    // Outbox payloads fan out to workers and external consumers.
    expect(serialize(events)).not.toContain(out.rawToken);
  });

  it("keeps the token out of the command_log response payload", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    const updates = fake.tx.commandLog.update.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { responsePayload?: { rawToken?: unknown } } }]
    >;
    const payload = updates[0]![0].data.responsePayload;
    // `redactFields` is the only thing standing between command_log and
    // a table of live reset links.
    expect(payload?.rawToken).not.toBe(out.rawToken);
    expect(serialize(updates[0]![0].data)).not.toContain(out.rawToken);
  });
});
