// RevokeSessions contract tests — self-service "log out everywhere".
//
// Pins the two things an operator relies on when they believe their
// account is compromised: `scope: "all"` really spares nothing, and the
// command can only ever reach the ACTOR's own sessions. Also covers the
// default scope, the exceptSessionId requirement, and the idempotency
// replay a double-submitted button produces.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { RevokeSessions } from "./revoke-sessions.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000ac";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000000c1";
const CURRENT_SESSION_ID = "00000000-0000-4000-8000-0000000000ff";
const NOW = new Date("2026-07-13T12:00:00.000Z");

// Deliberately NO permissions — the command is self-service.
const emptyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set(),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface CachedIdempotency {
  readonly requestHash: string;
  readonly responsePayload: unknown;
  readonly responseStatus: number | null;
}

function buildFake(opts: { readonly revokedCount?: number } = {}) {
  // Holds whatever the bus cached, so a second attempt with the same
  // key takes the real replay path instead of a fresh miss.
  const store: { row: CachedIdempotency | null } = { row: null };

  const tx = {
    // Declare an args param so `mock.calls[n][0]` is typed as the
    // captured argument (not an out-of-range empty-tuple index).
    authSession: {
      updateMany: vi.fn(async (_args: unknown) => ({ count: opts.revokedCount ?? 4 })),
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
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    idempotencyKey: {
      create: vi.fn(async (args: { data: { requestHash: string; responsePayload: unknown } }) => {
        store.row = {
          requestHash: args.data.requestHash,
          responsePayload: args.data.responsePayload,
          responseStatus: null,
        };
        return {};
      }),
      findUnique: vi.fn(async () => store.row),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: { create: vi.fn(async () => ({ id: "cl-pre" })), update: vi.fn(async () => ({})) },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
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

function revokeWhere(fake: ReturnType<typeof buildFake>) {
  const calls = fake.tx.authSession.updateMany.mock.calls as unknown as ReadonlyArray<
    readonly [
      {
        where: { userId: string; revokedAt: null; id?: { not: string } };
        data: { revokedAt: Date; revokedReason: string };
      },
    ]
  >;
  return calls[0]![0];
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_ID, grants: emptyGrants },
    ]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("RevokeSessions", () => {
  it("defaults to keeping the calling session (no permission required) and audits it", async () => {
    const fake = buildFake({ revokedCount: 4 });
    configureBus(fake.client);

    // `scope` omitted on purpose: the schema default decides.
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RevokeSessions,
        { exceptSessionId: CURRENT_SESSION_ID },
        { idempotencyKey: "revoke-default" }
      )
    );

    expect(out.userId).toBe(ACTOR_ID);
    expect(out.revoked).toBe(4);

    const args = revokeWhere(fake);
    expect(args.where.id).toEqual({ not: CURRENT_SESSION_ID });
    expect(args.data.revokedAt).toEqual(NOW);
    expect(args.data.revokedReason).toBe("USER_LOGOUT");

    const audits = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { action: string; resourceId: string; metadata: Record<string, unknown> } }]
    >;
    expect(audits[0]![0].data.action).toBe("user.sessions_revoked");
    expect(audits[0]![0].data.resourceId).toBe(ACTOR_ID);
    // Operators investigating an incident need to see which variant ran
    // and how much it actually killed.
    expect(audits[0]![0].data.metadata["scope"]).toBe("others");
    expect(audits[0]![0].data.metadata["revoked"]).toBe(4);
  });

  it("spares nothing under scope 'all', even when a session id is supplied", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RevokeSessions,
        { scope: "all", exceptSessionId: CURRENT_SESSION_ID },
        { idempotencyKey: "revoke-all" }
      )
    );

    expect(out.revoked).toBe(4);
    const args = revokeWhere(fake);
    // "All" is the compromised-account button. If the exclusion ever
    // leaked into this branch, the attacker's session would survive the
    // very action taken to kill it.
    expect(args.where.id).toBeUndefined();
    expect(args.where.revokedAt).toBeNull();
  });

  it("only ever targets the actor's own sessions", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(RevokeSessions, { scope: "all" }, { idempotencyKey: "revoke-self-only" })
    );

    // The user id comes from the tenancy context, never from input —
    // there is no way to sign someone else out of the building.
    expect(revokeWhere(fake).where.userId).toBe(ACTOR_ID);
  });

  it("refuses an input that names another user, before any write", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RevokeSessions,
          { scope: "all", userId: OTHER_USER_ID } as unknown as { scope: "all" },
          { idempotencyKey: "revoke-foreign" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    // The schema is strict: an unexpected field is rejected outright
    // rather than silently ignored, so a future handler change cannot
    // start honouring a smuggled target.
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("refuses scope 'others' with no session to keep", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(RevokeSessions, { scope: "others" }, { idempotencyKey: "revoke-no-except" })
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    // Without this refinement "others" with a missing id degrades into
    // "all", signing the caller out of the tab they are working in.
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("replays a resubmitted request instead of revoking twice", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    const input = { scope: "all" } as const;
    const first = await withTenancyContext(ctx(), () =>
      executeCommand(RevokeSessions, input, { idempotencyKey: "revoke-dupe" })
    );
    const second = await withTenancyContext(ctx(), () =>
      executeCommand(RevokeSessions, input, { idempotencyKey: "revoke-dupe" })
    );

    expect(second).toEqual(first);
    // A double-submitted button must not run the revoke again or append
    // a second audit row claiming a second logout-everywhere happened.
    expect(fake.tx.authSession.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
