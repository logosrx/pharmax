// IssueInvite contract tests (bus-integrated, DB-free).
//
// The raw token this command returns is, for its lifetime, the entire
// credential for an account that has no password yet: whoever holds it
// sets the first password. That makes four properties load-bearing:
//
//   - Only a hash of the token is persisted, and the raw value appears
//     in no bookkeeping row.
//   - Issuing a new invitation kills the previous unused one, so a
//     link that leaked cannot be redeemed after a re-invite.
//   - The token is high-entropy and unique per issue, and its lifetime
//     is the invitation TTL rather than the (much shorter) reset TTL.
//   - The token is filed under an organization the user actually
//     belongs to. See the tenancy block at the bottom of this file.

import { createHash } from "node:crypto";

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
import { DEFAULT_INVITE_TTL_MS, ISSUE_INVITE_USER_NOT_FOUND, IssueInvite } from "./issue-invite.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-08-01T12:00:00.000Z");

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

/**
 * `member` is the ONE user row the fake database holds. `user.findFirst`
 * answers it only when BOTH `id` and `organizationId` in the `where`
 * match — the same thing Postgres would do — so a test that points the
 * command at the wrong organization gets a real miss rather than a
 * stubbed one.
 */
function buildFake(
  member: { userId: string; organizationId: string } = {
    userId: USER_ID,
    organizationId: ORG_ID,
  }
) {
  const tx = {
    user: {
      findFirst: vi.fn(async (args: { where: { id: string; organizationId: string } }) =>
        args.where.id === member.userId && args.where.organizationId === member.organizationId
          ? { id: member.userId }
          : null
      ),
    },
    passwordResetToken: {
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      create: vi.fn(async (_args: unknown) => ({ id: "prt-1" })),
    },
    commandLog: {
      create: vi.fn(async (_args: unknown) => ({ id: "cl-1" })),
      update: vi.fn(async (_args: unknown) => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async (_args: unknown) => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async (_args: unknown) => ({ count: 1 })) },
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

function run(overrides: Record<string, unknown> = {}) {
  return withSystemContext("test:issue-invite", () =>
    executeSystemCommand(IssueInvite, {
      userId: USER_ID,
      organizationId: ORG_ID,
      ...overrides,
    })
  );
}

function storedToken(fake: ReturnType<typeof buildFake>) {
  return fake.tx.passwordResetToken.create.mock.calls[0]![0] as {
    data: {
      organizationId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      createdAt: Date;
    };
  };
}

/** BigInt-safe serialization — audit rows carry a `seq` bigint. */
function serializeCalls(calls: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({ clock: clock.createFrozenClock(NOW), hasher: fakeHasher })
  );
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("IssueInvite", () => {
  it("persists only a hash of the token it hands back", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    const stored = storedToken(fake).data;
    expect(stored.tokenHash).not.toBe(out.rawToken);
    // A readable token column would let anyone with database access
    // claim an invited account before its owner does.
    expect(stored.tokenHash).toBe(createHash("sha256").update(out.rawToken, "utf8").digest("hex"));
    expect(stored).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      createdAt: NOW,
    });
  });

  it("mints an unguessable token that differs on every issue", async () => {
    const first = buildFake();
    configureBus(first.client);
    const a = await run();

    const second = buildFake();
    configureBus(second.client);
    const b = await run();

    expect(a.rawToken).not.toBe(b.rawToken);
    // 32 random bytes base64url-encode to 43 characters. Anything
    // shorter would put the link within reach of a guessing attack.
    expect(a.rawToken.length).toBeGreaterThanOrEqual(43);
    expect(a.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("gives the invitation the seven-day lifetime, not the reset lifetime", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    const expected = new Date(NOW.getTime() + DEFAULT_INVITE_TTL_MS);
    expect(out.expiresAt).toEqual(expected);
    expect(storedToken(fake).data.expiresAt).toEqual(expected);
    // IssueInvite stamps the deadline; enforcing it is AcceptInvite's
    // job, which refuses once `expiresAt <= now`.
    expect(DEFAULT_INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("burns the previous unused invitation before minting a new one", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run();

    // Re-inviting is the remedy when a link is mis-delivered, so the
    // superseded link has to stop working. The `usedAt: null` filter
    // also leaves already-redeemed rows with their original stamp
    // instead of rewriting when they were consumed.
    expect(fake.tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, organizationId: ORG_ID, usedAt: null },
      data: { usedAt: NOW },
    });
    const invalidateOrder = fake.tx.passwordResetToken.updateMany.mock.invocationCallOrder[0]!;
    const mintOrder = fake.tx.passwordResetToken.create.mock.invocationCallOrder[0]!;
    expect(invalidateOrder).toBeLessThan(mintOrder);
  });

  it("files the token, the audit entry, and the event under the requested organization once the user is proven to belong to it", async () => {
    // The organization comes from the input — but only after the input
    // has been checked against the user's actual row. Seeding the user
    // INTO `OTHER_ORG_ID` is what makes the request legitimate; the
    // same call against the default fixture is refused by the test
    // below.
    const fake = buildFake({ userId: USER_ID, organizationId: OTHER_ORG_ID });
    configureBus(fake.client);

    await run({ organizationId: OTHER_ORG_ID });

    expect(fake.tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: USER_ID, organizationId: OTHER_ORG_ID },
      select: { id: true },
    });
    expect(storedToken(fake).data.organizationId).toBe(OTHER_ORG_ID);
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.invite_issued",
          resourceType: "User",
          resourceId: USER_ID,
          organizationId: OTHER_ORG_ID,
        }),
      })
    );
    expect(fake.tx.eventOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            eventType: "user.invite_issued.v1",
            organizationId: OTHER_ORG_ID,
          }),
        ],
      })
    );
  });

  it("keeps the raw token out of every bookkeeping row", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run();

    // The token is delivered by mail and never again; an audit or
    // command-log copy would outlive the delivery and be readable by
    // anyone with log access.
    const persisted = serializeCalls([
      ...fake.tx.auditLog.create.mock.calls,
      ...fake.tx.eventOutbox.createMany.mock.calls,
      ...fake.tx.commandLog.create.mock.calls,
      ...fake.tx.commandLog.update.mock.calls,
    ]);
    expect(persisted).not.toContain(out.rawToken);

    const succeeded = fake.tx.commandLog.update.mock.calls.at(-1)![0] as {
      data: { responsePayload: Record<string, unknown> };
    };
    expect(succeeded.data.responsePayload).toMatchObject({ rawToken: "[Redacted]" });
    // The expiry is safe to record and is what an operator needs to
    // answer "why did this link stop working?".
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            expiresAt: new Date(NOW.getTime() + DEFAULT_INVITE_TTL_MS).toISOString(),
          }),
        }),
      })
    );
  });
});

// `userId` and `organizationId` arrive as two independent inputs, and a
// SystemCommand runs in system context, where the tenancy extension
// passes through by design. Nothing below this command would notice a
// mispaired call: the token row would carry the wrong org, and
// AcceptInvite reads the org back OFF that row — putting one
// organization's user activation into another organization's audit
// trail and event stream. Those two artifacts are the tenant-scoped
// record of truth, so the pairing has to be proved here.
describe("IssueInvite — tenancy", () => {
  it("refuses a userId that belongs to a different organization", async () => {
    const fake = buildFake({ userId: USER_ID, organizationId: OTHER_ORG_ID });
    configureBus(fake.client);

    await expect(run({ organizationId: ORG_ID })).rejects.toMatchObject({
      name: "NotFoundError",
      code: ISSUE_INVITE_USER_NOT_FOUND,
      // 404, not 403: a "wrong organization" answer would confirm the
      // id exists somewhere, which is the cross-tenant existence leak
      // NotFoundError is documented to avoid. A caller who is entitled
      // to the id cannot tell it apart from a typo, and neither can a
      // caller who is not.
      httpStatus: 404,
    });
  });

  it("writes nothing at all when it refuses", async () => {
    const fake = buildFake({ userId: USER_ID, organizationId: OTHER_ORG_ID });
    configureBus(fake.client);

    await expect(run({ organizationId: ORG_ID })).rejects.toThrow();

    // No token to redeem, and — because a system command resolves its
    // target org from the handler and so writes command_log INSIDE the
    // transaction — no bookkeeping row under the org that was asked
    // for either. A refusal that still filed an audit entry under
    // ORG_ID would itself be the cross-tenant write.
    expect(fake.tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(fake.tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
    expect(fake.tx.eventOutbox.createMany).not.toHaveBeenCalled();
    expect(fake.tx.commandLog.create).not.toHaveBeenCalled();
  });

  it("proves membership before it writes anything", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run();

    // A check that runs after the sweep would already have burned the
    // user's live invitation on the way to refusing.
    const checkOrder = fake.tx.user.findFirst.mock.invocationCallOrder[0]!;
    expect(checkOrder).toBeLessThan(
      fake.tx.passwordResetToken.updateMany.mock.invocationCallOrder[0]!
    );
    expect(checkOrder).toBeLessThan(fake.tx.passwordResetToken.create.mock.invocationCallOrder[0]!);
  });

  it("scopes the prior-token sweep to the organization, not the user alone", async () => {
    // Seeded in OTHER_ORG_ID so a sweep that quietly used ORG_ID, or
    // dropped the organization entirely, cannot pass by coincidence.
    const fake = buildFake({ userId: USER_ID, organizationId: OTHER_ORG_ID });
    configureBus(fake.client);

    await run({ organizationId: OTHER_ORG_ID });

    // `usedAt` is a mutation. Filtering by `userId` alone would let one
    // organization's re-invite stamp another organization's live token
    // as consumed — a cross-tenant write, and an invite that stops
    // working for reasons no one in that org can explain.
    expect(fake.tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, organizationId: OTHER_ORG_ID, usedAt: null },
      data: { usedAt: NOW },
    });
  });
});
